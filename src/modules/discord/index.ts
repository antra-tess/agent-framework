/**
 * Discord Module - Discord integration for agent framework
 *
 * Provides:
 * - Listening to Discord messages and routing to agents
 * - Sending agent speech to Discord channels
 * - Tools for explicit Discord operations (send, DM, react, etc.)
 */

import type { ContentBlock } from '@animalabs/membrane';
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
  ListGuildsInput,
  ListChannelsInput,
  FetchHistoryInput,
} from './types.js';

// Re-export event types for consumers who want to handle them
export type { DiscordMessageEvent, DiscordEditEvent, DiscordDeleteEvent } from './types.js';

export * from './types.js';
export { DiscordJsClient, type DiscordJsClientConfig } from './discord-js-client.js';

const DEFAULT_CONFIG: Partial<DiscordModuleConfig> = {
  handleDMs: true,
  ignoreBots: true,
  rateLimitPerMinute: 30,
  triggerOn: 'mention_or_reply',
  autoTyping: true,
  historyScrollback: 50,
};

// Image MIME types that Claude can process
const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

// Text file extensions for inline reading
const TEXT_FILE_EXTENSIONS = [
  '.txt', '.md', '.json', '.yaml', '.yml', '.toml',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs',
  '.html', '.css', '.xml', '.csv', '.log', '.sh', '.bash',
];

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
    lastReadMessageId: {},
  };

  // Track current reply context per agent
  private replyContexts: Map<string, ConversationContext> = new Map();

  // Last message sent by a tool (for thought-editing)
  private lastSentMessage: { channelId: string; messageId: string } | null = null;

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

    // Set up ready handler for history sync on (re)connect
    if (this.client.onReady) {
      this.client.onReady(() => this.handleReady());
    }

    // Connect to Discord
    if (!ctx.isRestart || !this.client.isConnected()) {
      await this.client.connect();
    } else {
      // Already connected (restart) - sync history now
      await this.syncAllChannelHistory();
    }

    // Get bot user ID after connect
    const botUserId = this.client.getBotUserId();
    if (botUserId) {
      this.state.botUserId = botUserId;
      ctx.setState(this.state);
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
      // ========== Discovery & Utility Tools ==========
      {
        name: 'list_guilds',
        description: 'List all Discord servers (guilds) the bot is in',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_channels',
        description: 'List all channels in a Discord server',
        inputSchema: {
          type: 'object',
          properties: {
            guildId: { type: 'string', description: 'Guild/Server ID' },
          },
          required: ['guildId'],
        },
      },
      {
        name: 'fetch_history',
        description: 'Fetch recent message history from a channel',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID' },
            limit: { type: 'number', description: 'Number of messages to fetch (default: 50, max: 100)' },
            before: { type: 'string', description: 'Fetch messages before this message ID' },
          },
          required: ['channelId'],
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
        case 'list_guilds':
          return await this.handleListGuilds();
        case 'list_channels':
          return await this.handleListChannels(call.input as ListChannelsInput);
        case 'fetch_history':
          return await this.handleFetchHistory(call.input as FetchHistoryInput);
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
        lastReadMessageId: {},
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
        lastReadMessageId: {
          ...currentState.lastReadMessageId,
          [msg.channelId]: msg.discordMessageId,
        },
      };

      // Update local state reference for tool handlers
      this.state = newState;

      // Auto-send typing indicator if configured
      if (this.config.autoTyping) {
        // Fire and forget - don't await
        this.client.sendTyping(msg.channelId).catch((err) => {
          console.warn('Discord: Failed to send typing indicator:', err);
        });
      }

      // Build content blocks from message and attachments
      const contentBlocks = msg.contentBlocks ?? [{ type: 'text' as const, text: msg.content }];

      // Return declarative response - framework applies all writes atomically
      return {
        addMessages: [
          {
            participant: msg.authorName,
            content: contentBlocks,
            metadata: {
              external: { source: 'discord', id: msg.discordMessageId },
              channelId: msg.channelId,
              timestamp: msg.timestamp,
            },
          },
        ],
        stateUpdate: newState,
        requestInference: msg.shouldTriggerInference ?? true,
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
    context: SpeechContext
  ): Promise<void> {
    // If thoughts are present and we have a recently sent message, edit it
    // to prepend the thoughts as spoiler text.
    if (context.thoughts && context.thoughts.length > 0 && this.lastSentMessage) {
      const thoughtText = this.extractText(context.thoughts);
      if (thoughtText) {
        try {
          const { channelId, messageId } = this.lastSentMessage;
          // Fetch the current message content via the client isn't available,
          // but we know the tool just sent it — reconstruct by editing with
          // spoiler-wrapped thoughts prepended.
          // Discord API edit replaces content, so we need the original text.
          // We don't have it here, so use a get-then-edit pattern via the API.
          // For now, the simplest approach: the discord.js client can fetch & edit.
          await this.editWithThoughts(channelId, messageId, thoughtText);
        } catch (err) {
          console.warn('Discord: Failed to edit thoughts into message:', err);
        }
      }
      this.lastSentMessage = null;
    }

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
    const result = await this.client.sendMessage(targetChannel, text, {
      replyTo: replyCtx.replyToMessageId,
    });

    // Track for thought-editing (in case of chained speech)
    this.lastSentMessage = { channelId: targetChannel, messageId: result.messageId };

    // Clear reply-to after sending (don't keep replying to same message)
    replyCtx.replyToMessageId = undefined;
    replyCtx.lastActivity = Date.now();
  }

  /**
   * Edit a sent message to prepend thought text as spoilers.
   */
  private async editWithThoughts(
    channelId: string,
    messageId: string,
    thoughtText: string
  ): Promise<void> {
    // Fetch current message content
    const currentContent = await this.client.fetchMessage(channelId, messageId);
    // Prepend spoiler-wrapped thoughts
    const spoiler = `||${thoughtText}||\n`;
    await this.client.editMessage(channelId, messageId, spoiler + currentContent);
  }

  // ==========================================================================
  // Discord Event Handlers
  // ==========================================================================

  /**
   * Handle Discord ready event - sync history for all tracked channels.
   */
  private async handleReady(): Promise<void> {
    console.log('[Discord] Ready - syncing history for tracked channels');
    
    // Get bot user ID
    const botUserId = this.client.getBotUserId();
    if (botUserId) {
      this.state.botUserId = botUserId;
    }

    await this.syncAllChannelHistory();
  }

  /**
   * Sync history for all channels we have conversations in.
   */
  private async syncAllChannelHistory(): Promise<void> {
    if (!this.ctx) return;

    // Get unique channel IDs from conversations
    const channelIds = new Set<string>();
    for (const conv of Object.values(this.state.conversations)) {
      channelIds.add(conv.channelId);
    }

    if (channelIds.size === 0) {
      console.log('[Discord] No channels to sync');
      return;
    }

    console.log(`[Discord] Syncing history for ${channelIds.size} channel(s)`);

    const syncResults: Array<{
      channelId: string;
      newMessages: number;
      editedMessages: number;
      deletedMessages: number;
    }> = [];

    for (const channelId of channelIds) {
      try {
        const result = await this.syncChannelHistory(channelId);
        if (result.newMessages > 0 || result.editedMessages > 0 || result.deletedMessages > 0) {
          syncResults.push({ channelId, ...result });
        }
      } catch (error) {
        console.error(`[Discord] Failed to sync channel ${channelId}:`, error);
      }
    }

    // Emit sync complete event if there were any changes
    if (syncResults.length > 0 && this.ctx) {
      const totalNew = syncResults.reduce((sum, r) => sum + r.newMessages, 0);
      const totalEdited = syncResults.reduce((sum, r) => sum + r.editedMessages, 0);
      const totalDeleted = syncResults.reduce((sum, r) => sum + r.deletedMessages, 0);

      console.log(`[Discord] History sync complete: ${totalNew} new, ${totalEdited} edited, ${totalDeleted} deleted`);

      // Push a notification event (doesn't trigger inference, just informs)
      this.ctx.pushEvent({
        type: 'module-event',
        source: 'discord',
        eventType: 'history-sync-complete',
        payload: {
          channels: syncResults.length,
          newMessages: totalNew,
          editedMessages: totalEdited,
          deletedMessages: totalDeleted,
        },
      });
    }

    this.ctx?.setState(this.state);
  }

  /**
   * Sync history for a specific channel - compare with Context Manager and update.
   * Uses queryMessages() to enumerate stored messages for proper edit/delete detection.
   */
  private async syncChannelHistory(channelId: string): Promise<{
    newMessages: number;
    editedMessages: number;
    deletedMessages: number;
  }> {
    if (!this.ctx) {
      return { newMessages: 0, editedMessages: 0, deletedMessages: 0 };
    }

    const scrollback = this.config.historyScrollback ?? 50;
    
    // Fetch recent history from Discord
    const discordMessages = await this.client.fetchHistory(channelId, { limit: scrollback });
    
    // Build a map of Discord message ID -> content for comparison
    const discordMessageMap = new Map<string, { content: string; authorName: string; timestamp: Date }>();
    for (const msg of discordMessages) {
      discordMessageMap.set(msg.id, {
        content: msg.content,
        authorName: msg.authorName,
        timestamp: msg.timestamp,
      });
    }

    // Query Context Manager for all Discord messages from this channel
    const { messages: storedMessages } = this.ctx.queryMessages({
      source: 'discord',
      metadata: { channelId },
    });

    // Build a map of stored message external IDs -> internal data
    const storedMessageMap = new Map<string, { internalId: string; content: string }>();
    for (const msg of storedMessages) {
      const external = msg.metadata?.external as { id?: string } | undefined;
      if (external?.id) {
        // Extract text content for comparison
        const textContent = msg.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        storedMessageMap.set(external.id, {
          internalId: msg.id,
          content: textContent,
        });
      }
    }

    let newMessages = 0;
    let editedMessages = 0;
    let deletedMessages = 0;

    // Process Discord messages - check for new/edited
    for (const discordMsg of discordMessages) {
      const stored = storedMessageMap.get(discordMsg.id);
      
      if (!stored) {
        // New message we haven't seen
        // For bot's own messages (from previous sessions), use the agent name
        // This ensures continuity of conversation history
        const isBotMessage = discordMsg.authorId === this.state.botUserId;
        const agentName = this.ctx.getAgents()[0]?.name;
        const participantName = isBotMessage 
          ? (agentName ?? discordMsg.authorName)
          : discordMsg.authorName;
        
        this.ctx.addMessage(
          participantName,
          [{ type: 'text', text: discordMsg.content }],
          {
            external: { source: 'discord', id: discordMsg.id },
            channelId,
            timestamp: discordMsg.timestamp.getTime(),
            isOwnMessage: isBotMessage, // Mark as our own for reference
          }
        );
        newMessages++;
      } else {
        // We have this message - check if content changed (offline edit detection)
        if (stored.content !== discordMsg.content) {
          this.ctx.editMessage(stored.internalId, [
            { type: 'text', text: discordMsg.content },
          ]);
          editedMessages++;
        }
      }
    }

    // Check for deletes - messages we have that Discord doesn't
    // Only consider messages within the scrollback window (recent ones)
    for (const [externalId, stored] of storedMessageMap) {
      if (!discordMessageMap.has(externalId)) {
        // Message exists in our store but not in Discord - it was deleted
        // Note: This only catches deletes within the scrollback window
        this.ctx.removeMessage(stored.internalId);
        deletedMessages++;
      }
    }

    // Update last read
    if (discordMessages.length > 0) {
      // Messages are typically newest first
      const newestId = discordMessages[0].id;
      this.state.lastReadMessageId[channelId] = newestId;
    }

    return { newMessages, editedMessages, deletedMessages };
  }

  private async handleDiscordMessage(message: DiscordMessageData): Promise<void> {
    if (!this.ctx) return;

    // ALWAYS ignore our own messages to prevent feedback loops
    if (this.state.botUserId && message.authorId === this.state.botUserId) {
      return;
    }

    // Optionally ignore other bots
    if (this.config.ignoreBots && message.isBot) {
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
    const isDM = !message.guildId;
    if (isDM && !this.config.handleDMs) {
      return;
    }

    // Determine if this message should trigger inference
    const shouldTrigger = this.shouldTriggerInference(message, isDM);

    // Convert message content including attachments
    const contentBlocks = await this.convertMessageToContent(message);

    // Only queue the event - all state writes happen in onProcess()
    this.ctx.pushEvent({
      type: 'discord:message',
      discordMessageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.authorId,
      authorName: message.authorName,
      content: message.content,
      contentBlocks,
      timestamp: message.timestamp.getTime(),
      attachments: message.attachments,
      shouldTriggerInference: shouldTrigger,
    } as DiscordMessageEvent);
  }

  /**
   * Convert Discord message to ContentBlock array.
   * Includes text content and any supported attachments (images, text files).
   */
  private async convertMessageToContent(message: DiscordMessageData): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];

    // Add text content if present
    if (message.content.trim()) {
      blocks.push({ type: 'text', text: message.content });
    }

    // Process attachments
    for (const attachment of message.attachments) {
      const contentType = attachment.contentType?.toLowerCase() ?? '';
      const filename = attachment.filename.toLowerCase();

      // Check for supported image types
      if (SUPPORTED_IMAGE_TYPES.some(type => contentType.startsWith(type))) {
        blocks.push({
          type: 'image',
          source: {
            type: 'url',
            url: attachment.url,
          },
        } as ContentBlock);
        continue;
      }

      // Check for text files - fetch and include content
      const isTextFile = TEXT_FILE_EXTENSIONS.some(ext => filename.endsWith(ext));
      if (isTextFile && attachment.size && attachment.size < 100_000) { // < 100KB
        try {
          const response = await fetch(attachment.url);
          if (response.ok) {
            const textContent = await response.text();
            blocks.push({
              type: 'text',
              text: `\n--- File: ${attachment.filename} ---\n${textContent}\n--- End of ${attachment.filename} ---\n`,
            });
          }
        } catch (error) {
          // If fetch fails, just note the attachment
          blocks.push({
            type: 'text',
            text: `[Attachment: ${attachment.filename} (failed to fetch)]`,
          });
        }
        continue;
      }

      // For unsupported attachments, add a note
      blocks.push({
        type: 'text',
        text: `[Attachment: ${attachment.filename} (${contentType || 'unknown type'})]`,
      });
    }

    // Ensure we have at least empty text if nothing else
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: '[Empty message]' });
    }

    return blocks;
  }

  /**
   * Determine if a message should trigger agent inference based on config.
   */
  private shouldTriggerInference(message: DiscordMessageData, isDM: boolean): boolean {
    const triggerMode = this.config.triggerOn ?? 'mention_or_reply';
    const botUserId = this.state.botUserId;

    // Check if bot is mentioned
    const isMentioned = botUserId
      ? message.mentionedUserIds.includes(botUserId)
      : false;

    // Check if this is a reply to bot's message
    const isReplyToBot = botUserId
      ? message.replyToAuthorId === botUserId
      : false;

    switch (triggerMode) {
      case 'all':
        // Always trigger (use with caution!)
        return true;

      case 'mention':
        // Only trigger on direct @mention
        return isMentioned;

      case 'mention_or_reply':
        // Trigger on @mention OR when replying to bot
        return isMentioned || isReplyToBot;

      case 'dm_or_mention':
        // DMs always trigger, channels require mention
        return isDM || isMentioned;

      default:
        // Fallback: mention_or_reply behavior
        return isMentioned || isReplyToBot;
    }
  }

  private handleDiscordMessageEdit(messageId: string, newContent: string): void {
    if (!this.ctx) return;

    // Only queue the event - state writes happen in onProcess()
    this.ctx.pushEvent({
      type: 'discord:edit',
      discordMessageId: messageId,
      newContent,
    });
  }

  private handleDiscordMessageDelete(messageId: string): void {
    if (!this.ctx) return;

    // Only queue the event - state writes happen in onProcess()
    this.ctx.pushEvent({
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

    // Track for thought-editing
    this.lastSentMessage = { channelId: input.channelId, messageId: result.messageId };

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

    // Track for thought-editing
    this.lastSentMessage = { channelId: targetChannel, messageId: result.messageId };

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

  private async handleListGuilds(): Promise<ToolResult> {
    const guilds = await this.client.listGuilds();
    return {
      success: true,
      data: {
        guilds: guilds.map((g) => ({
          id: g.id,
          name: g.name,
          memberCount: g.memberCount,
        })),
      },
    };
  }

  private async handleListChannels(input: ListChannelsInput): Promise<ToolResult> {
    const channels = await this.client.listChannels(input.guildId);
    return {
      success: true,
      data: {
        guildId: input.guildId,
        channels: channels.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          parentId: c.parentId,
        })),
      },
    };
  }

  private async handleFetchHistory(input: FetchHistoryInput): Promise<ToolResult> {
    const limit = Math.min(input.limit ?? 50, 100); // Cap at 100
    const messages = await this.client.fetchHistory(input.channelId, {
      limit,
      before: input.before,
    });

    // Update last read if we got messages
    if (messages.length > 0) {
      const latestId = messages[0].id; // Assuming sorted newest first
      this.state.lastReadMessageId[input.channelId] = latestId;
      this.ctx?.setState(this.state);
    }

    return {
      success: true,
      data: {
        channelId: input.channelId,
        messageCount: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          author: m.authorName,
          authorId: m.authorId,
          isBot: m.isBot,
          content: m.content,
          timestamp: m.timestamp.toISOString(),
          replyTo: m.replyTo,
        })),
      },
    };
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
