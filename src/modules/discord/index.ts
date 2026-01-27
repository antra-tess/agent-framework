/**
 * Discord Module - Discord integration for agent framework
 *
 * Provides:
 * - Listening to Discord messages and routing to agents
 * - Sending agent speech to Discord channels
 * - Tools for explicit Discord operations (send, DM, react, etc.)
 */

import type { ContentBlock } from 'membrane';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  SpeechContext,
} from '../../types/index.js';
import type {
  DiscordModuleConfig,
  DiscordModuleState,
  ConversationContext,
  DiscordClientInterface,
  DiscordMessageData,
  DiscordMessageEvent,
  DiscordEditEvent,
  DiscordDeleteEvent,
  SendInput,
  SendDMInput,
  ReplyInput,
  ReactInput,
  EditMessageInput,
  DeleteMessageInput,
  CreateThreadInput,
  SetReplyContextInput,
} from './types.js';

// Re-export event types for consumers who want to handle them
export type { DiscordMessageEvent, DiscordEditEvent, DiscordDeleteEvent } from './types.js';

export * from './types.js';
export { DiscordJsClient, type DiscordJsClientConfig } from './discord-js-client.js';

const DEFAULT_CONFIG: Partial<DiscordModuleConfig> = {
  handleDMs: true,
  ignoreBots: true,
  rateLimitPerMinute: 30,
};

const CONVERSATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Discord module for the agent framework.
 */
export class DiscordModule implements Module {
  readonly name = 'discord';

  private config: DiscordModuleConfig;
  private ctx: ModuleContext | null = null;
  private client: DiscordClientInterface;
  private state: DiscordModuleState = {
    connectedGuilds: [],
    conversations: {},
    rateLimits: {},
  };

  // Track current reply context per agent
  private replyContexts: Map<string, ConversationContext> = new Map();

  constructor(client: DiscordClientInterface, config: DiscordModuleConfig) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Load persisted state
    const savedState = ctx.getState<DiscordModuleState>();
    if (savedState) {
      this.state = savedState;
      // Clean up old conversations
      this.cleanupOldConversations();
    }

    // Register as speech handler
    ctx.registerSpeechHandler('*');

    // Set up Discord event handlers
    this.client.onMessage((message) => this.handleDiscordMessage(message));
    this.client.onMessageEdit((id, content) => this.handleDiscordMessageEdit(id, content));
    this.client.onMessageDelete((id) => this.handleDiscordMessageDelete(id));

    // Connect to Discord
    if (!ctx.isRestart || !this.client.isConnected()) {
      await this.client.connect();
    }
  }

  async stop(): Promise<void> {
    // Save state
    if (this.ctx) {
      this.ctx.setState(this.state);
    }

    await this.client.disconnect();
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'send',
        description: 'Send a message to a specific Discord channel',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID to send to' },
            content: { type: 'string', description: 'Message content' },
            replyTo: { type: 'string', description: 'Message ID to reply to (optional)' },
            createThread: {
              type: 'object',
              description: 'Create a thread with this message',
              properties: {
                name: { type: 'string', description: 'Thread name' },
              },
            },
          },
          required: ['channelId', 'content'],
        },
      },
      {
        name: 'dm',
        description: 'Send a direct message to a user',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'User ID to DM' },
            content: { type: 'string', description: 'Message content' },
          },
          required: ['userId', 'content'],
        },
      },
      {
        name: 'reply',
        description:
          'Reply in the current conversation context. Use this for normal responses.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Message content' },
            mention: { type: 'boolean', description: 'Whether to mention the user' },
          },
          required: ['content'],
        },
      },
      {
        name: 'react',
        description: 'Add a reaction to a message',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID' },
            messageId: { type: 'string', description: 'Message ID to react to' },
            emoji: { type: 'string', description: 'Emoji (unicode or custom emoji ID)' },
          },
          required: ['channelId', 'messageId', 'emoji'],
        },
      },
      {
        name: 'edit',
        description: 'Edit a message sent by this bot',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID' },
            messageId: { type: 'string', description: 'Message ID to edit' },
            content: { type: 'string', description: 'New content' },
          },
          required: ['channelId', 'messageId', 'content'],
        },
      },
      {
        name: 'delete',
        description: 'Delete a message sent by this bot',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID' },
            messageId: { type: 'string', description: 'Message ID to delete' },
          },
          required: ['channelId', 'messageId'],
        },
      },
      {
        name: 'create_thread',
        description: 'Create a thread from a message',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID' },
            messageId: { type: 'string', description: 'Message ID to create thread from' },
            name: { type: 'string', description: 'Thread name' },
            autoArchiveDuration: {
              type: 'number',
              description: 'Auto-archive duration in minutes (60, 1440, 4320, 10080)',
            },
          },
          required: ['channelId', 'messageId', 'name'],
        },
      },
      {
        name: 'set_reply_context',
        description: 'Change where default speech goes for this conversation',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID for replies' },
            threadId: { type: 'string', description: 'Thread ID (optional)' },
            replyToMessageId: { type: 'string', description: 'Message ID to reply to (optional)' },
          },
          required: ['channelId'],
        },
      },
      {
        name: 'activate',
        description: 'Register Discord as the speech handler (take over from other modules)',
        inputSchema: {
          type: 'object',
          properties: {
            additive: {
              type: 'boolean',
              description: 'If true, add to existing handlers instead of replacing',
            },
          },
        },
      },
      {
        name: 'deactivate',
        description: 'Unregister Discord as a speech handler',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case 'send':
          return await this.handleSend(call.input as SendInput);
        case 'dm':
          return await this.handleDM(call.input as SendDMInput);
        case 'reply':
          return await this.handleReply(call.input as ReplyInput);
        case 'react':
          return await this.handleReact(call.input as ReactInput);
        case 'edit':
          return await this.handleEdit(call.input as EditMessageInput);
        case 'delete':
          return await this.handleDelete(call.input as DeleteMessageInput);
        case 'create_thread':
          return await this.handleCreateThread(call.input as CreateThreadInput);
        case 'set_reply_context':
          return await this.handleSetReplyContext(call.input as SetReplyContextInput);
        case 'activate':
          return await this.handleActivate(call.input as { additive?: boolean });
        case 'deactivate':
          return await this.handleDeactivate();
        default:
          return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  async onProcess(event: ProcessEvent, state: ProcessState): Promise<EventResponse> {
    // Handle new Discord message
    if (event.type === 'discord:message') {
      const msg = event as DiscordMessageEvent;
      const currentState = state.getState<DiscordModuleState>() ?? {
        connectedGuilds: [],
        conversations: {},
        rateLimits: {},
      };

      // Build conversation state update
      const convKey = msg.guildId ? `${msg.guildId}:${msg.channelId}` : `dm:${msg.authorId}`;
      const conversation: ConversationContext = {
        channelId: msg.channelId,
        userId: msg.authorId,
        guildId: msg.guildId ?? null,
        replyToMessageId: msg.discordMessageId,
        lastActivity: Date.now(),
      };

      // Update in-memory reply context (ephemeral, not persisted)
      this.replyContexts.set('default', conversation);

      // Build new state with updated conversation
      const newState: DiscordModuleState = {
        ...currentState,
        conversations: {
          ...currentState.conversations,
          [convKey]: conversation,
        },
      };

      // Update local state reference for tool handlers
      this.state = newState;

      // Return declarative response - framework applies all writes atomically
      return {
        addMessages: [
          {
            participant: msg.authorName,
            content: [{ type: 'text', text: msg.content }],
            metadata: {
              external: { source: 'discord', id: msg.discordMessageId },
              timestamp: msg.timestamp,
            },
          },
        ],
        stateUpdate: newState,
        requestInference: true,
      };
    }

    // Handle Discord message edit
    if (event.type === 'discord:edit') {
      const edit = event as DiscordEditEvent;
      const internalId = state.findMessageByExternalId('discord', edit.discordMessageId);
      if (!internalId) {
        return {};
      }
      return {
        editMessages: [
          {
            messageId: internalId,
            content: [{ type: 'text', text: edit.newContent }],
          },
        ],
      };
    }

    // Handle Discord message delete
    if (event.type === 'discord:delete') {
      const del = event as DiscordDeleteEvent;
      const internalId = state.findMessageByExternalId('discord', del.discordMessageId);
      if (!internalId) {
        return {};
      }
      return {
        removeMessages: [internalId],
      };
    }

    return {};
  }

  /**
   * Handle agent speech - send to Discord.
   */
  async onAgentSpeech(
    agentName: string,
    content: ContentBlock[],
    _context: SpeechContext
  ): Promise<void> {
    // Get reply context for this agent
    const replyCtx = this.replyContexts.get(agentName) ?? this.replyContexts.get('default');
    if (!replyCtx) {
      // No conversation context - nowhere to send
      console.warn(`Discord: No reply context for agent ${agentName}`);
      return;
    }

    // Extract text content
    const text = this.extractText(content);
    if (!text) {
      return;
    }

    // Check rate limit
    if (!this.checkRateLimit(replyCtx.channelId)) {
      console.warn(`Discord: Rate limited for channel ${replyCtx.channelId}`);
      return;
    }

    // Send to Discord
    const targetChannel = replyCtx.threadId ?? replyCtx.channelId;
    await this.client.sendMessage(targetChannel, text, {
      replyTo: replyCtx.replyToMessageId,
    });

    // Clear reply-to after sending (don't keep replying to same message)
    replyCtx.replyToMessageId = undefined;
    replyCtx.lastActivity = Date.now();
  }

  // ==========================================================================
  // Discord Event Handlers
  // ==========================================================================

  private handleDiscordMessage(message: DiscordMessageData): void {
    if (!this.ctx) return;

    // Ignore bots if configured
    if (this.config.ignoreBots && message.authorId === 'bot') {
      return;
    }

    // Check if we should handle this channel
    if (this.config.channelIds && !this.config.channelIds.includes(message.channelId)) {
      return;
    }

    // Check if we should handle this guild
    if (
      message.guildId &&
      this.config.guildIds &&
      !this.config.guildIds.includes(message.guildId)
    ) {
      return;
    }

    // Check if we should handle DMs
    if (!message.guildId && !this.config.handleDMs) {
      return;
    }

    // Only queue the event - all state writes happen in onProcess()
    this.ctx.queue.push({
      type: 'discord:message',
      discordMessageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.authorId,
      authorName: message.authorName,
      content: message.content,
      timestamp: message.timestamp,
      attachments: message.attachments,
    });
  }

  private handleDiscordMessageEdit(messageId: string, newContent: string): void {
    if (!this.ctx) return;

    // Only queue the event - state writes happen in onProcess()
    this.ctx.queue.push({
      type: 'discord:edit',
      discordMessageId: messageId,
      newContent,
    });
  }

  private handleDiscordMessageDelete(messageId: string): void {
    if (!this.ctx) return;

    // Only queue the event - state writes happen in onProcess()
    this.ctx.queue.push({
      type: 'discord:delete',
      discordMessageId: messageId,
    });
  }

  // ==========================================================================
  // Tool Handlers
  // ==========================================================================

  private async handleSend(input: SendInput): Promise<ToolResult> {
    if (!this.checkRateLimit(input.channelId)) {
      return { success: false, error: 'Rate limited', isError: true };
    }

    const result = await this.client.sendMessage(input.channelId, input.content, {
      replyTo: input.replyTo,
      createThread: input.createThread,
    });

    return { success: true, data: { messageId: result.messageId } };
  }

  private async handleDM(input: SendDMInput): Promise<ToolResult> {
    const result = await this.client.sendDM(input.userId, input.content);
    return { success: true, data: { messageId: result.messageId } };
  }

  private async handleReply(input: ReplyInput): Promise<ToolResult> {
    const replyCtx = this.replyContexts.get('default');
    if (!replyCtx) {
      return { success: false, error: 'No conversation context', isError: true };
    }

    if (!this.checkRateLimit(replyCtx.channelId)) {
      return { success: false, error: 'Rate limited', isError: true };
    }

    let content = input.content;
    if (input.mention && replyCtx.userId) {
      content = `<@${replyCtx.userId}> ${content}`;
    }

    const targetChannel = replyCtx.threadId ?? replyCtx.channelId;
    const result = await this.client.sendMessage(targetChannel, content, {
      replyTo: replyCtx.replyToMessageId,
    });

    // Clear reply-to after sending
    replyCtx.replyToMessageId = undefined;
    replyCtx.lastActivity = Date.now();

    return { success: true, data: { messageId: result.messageId } };
  }

  private async handleReact(input: ReactInput): Promise<ToolResult> {
    await this.client.addReaction(input.channelId, input.messageId, input.emoji);
    return { success: true };
  }

  private async handleEdit(input: EditMessageInput): Promise<ToolResult> {
    await this.client.editMessage(input.channelId, input.messageId, input.content);
    return { success: true };
  }

  private async handleDelete(input: DeleteMessageInput): Promise<ToolResult> {
    await this.client.deleteMessage(input.channelId, input.messageId);
    return { success: true };
  }

  private async handleCreateThread(input: CreateThreadInput): Promise<ToolResult> {
    const result = await this.client.createThread(
      input.channelId,
      input.messageId,
      input.name,
      input.autoArchiveDuration
    );

    // Update reply context to use the new thread
    const replyCtx = this.replyContexts.get('default');
    if (replyCtx) {
      replyCtx.threadId = result.threadId;
    }

    return { success: true, data: { threadId: result.threadId } };
  }

  private async handleSetReplyContext(input: SetReplyContextInput): Promise<ToolResult> {
    const replyCtx = this.replyContexts.get('default');
    if (replyCtx) {
      replyCtx.channelId = input.channelId;
      replyCtx.threadId = input.threadId;
      replyCtx.replyToMessageId = input.replyToMessageId;
    } else {
      this.replyContexts.set('default', {
        channelId: input.channelId,
        threadId: input.threadId,
        replyToMessageId: input.replyToMessageId,
        userId: '',
        guildId: null,
        lastActivity: Date.now(),
      });
    }

    return { success: true };
  }

  private async handleActivate(input: { additive?: boolean }): Promise<ToolResult> {
    if (!this.ctx) {
      return { success: false, error: 'Module not started', isError: true };
    }

    this.ctx.registerSpeechHandler('*', { additive: input.additive });
    return { success: true, data: { message: 'Discord is now handling speech' } };
  }

  private async handleDeactivate(): Promise<ToolResult> {
    if (!this.ctx) {
      return { success: false, error: 'Module not started', isError: true };
    }

    this.ctx.unregisterSpeechHandler();
    return { success: true, data: { message: 'Discord is no longer handling speech' } };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private extractText(content: ContentBlock[]): string {
    return content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  private checkRateLimit(channelId: string): boolean {
    const limit = this.config.rateLimitPerMinute ?? 30;
    const now = Date.now();
    const windowMs = 60 * 1000;

    let info = this.state.rateLimits[channelId];
    if (!info || now - info.windowStart > windowMs) {
      // New window
      info = { count: 0, windowStart: now };
      this.state.rateLimits[channelId] = info;
    }

    if (info.count >= limit) {
      return false;
    }

    info.count++;
    return true;
  }

  private cleanupOldConversations(): void {
    const now = Date.now();
    for (const [key, conv] of Object.entries(this.state.conversations)) {
      if (now - conv.lastActivity > CONVERSATION_TIMEOUT_MS) {
        delete this.state.conversations[key];
      }
    }
  }
}
