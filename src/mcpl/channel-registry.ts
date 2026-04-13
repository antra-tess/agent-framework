/**
 * ChannelRegistry — manages MCPL channel lifecycle, incoming messages, and
 * synthesized channel tools.
 *
 * Adapted from battle-tested patterns in Anarchid/agent-framework@mcpl-module-proto.
 *
 * Responsibilities:
 * - Register/unregister channel descriptors from MCPL servers
 * - Auto-open channels on registration
 * - Route incoming messages to the processing queue
 * - Manage typing indicator timers (7s interval for Discord compatibility)
 * - Expose synthesized tools: channel_list, channel_open, channel_close, channel_publish
 * - Build channel context for beforeInference params
 */

import type { ContentBlock } from '@animalabs/membrane';

import type {
  ChannelDescriptor,
  ChannelContext,
  ChannelsRegisterParams,
  ChannelsRegisterResult,
  ChannelsChangedParams,
  ChannelsIncomingParams,
  ChannelsIncomingResult,
  ChannelIncomingMessageResult,
  ChannelsPublishParams,
  McplContentBlock,
} from './types.js';

import type { McplServerRegistry } from './server-registry.js';
import type { FeatureSetManager } from './feature-set-manager.js';
import type { ToolDefinition, ToolResult, ProcessEvent } from '../types/index.js';

// ============================================================================
// Typing indicator interval (Discord typing lasts ~10s, so 7s keeps it alive)
// ============================================================================

const TYPING_INTERVAL_MS = 7_000;

// ============================================================================
// Internal Types
// ============================================================================

/** A registered channel entry, keyed by `{serverId}:{channelId}`. */
interface ChannelEntry {
  serverId: string;
  descriptor: ChannelDescriptor;
  open: boolean;
}

/** Minimal responder interface for sending JSON-RPC results back. */
interface Responder {
  respond(result: unknown): void;
  respondError?(code: number, message: string, data?: unknown): void;
}

/**
 * Event pushed to the processing queue when an incoming channel message arrives.
 * Uses the CustomEvent pattern (`${string}:${string}`) from ProcessEvent.
 */
interface McplChannelIncomingEvent {
  type: 'mcpl:channel-incoming';
  serverId: string;
  channelId: string;
  messageId: string;
  threadId?: string;
  author: { id: string; name: string };
  content: ContentBlock[];
  timestamp: string;
  metadata?: Record<string, unknown>;
  triggerInference?: boolean;
  targetAgents?: string[];
}

// ============================================================================
// Content Conversion: McplContentBlock → membrane ContentBlock
// ============================================================================

/**
 * Convert a single MCPL wire-format content block to a membrane ContentBlock.
 */
function convertBlock(block: McplContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'image':
      if (block.data && block.mimeType) {
        return {
          type: 'image',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        } as ContentBlock;
      }
      if (block.uri) {
        return {
          type: 'image',
          source: { type: 'url', url: block.uri },
        } as ContentBlock;
      }
      return { type: 'text', text: '[Image: no data]' };

    case 'audio':
      if (block.data && block.mimeType) {
        return {
          type: 'audio',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        } as ContentBlock;
      }
      return { type: 'text', text: '[Audio: no data]' };

    case 'resource':
      return { type: 'text', text: `[Resource: ${block.uri}]` };
  }
}

// ============================================================================
// Channel Tool Definitions
// ============================================================================

const CHANNEL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'channel_list',
    description: 'List all available channels',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'channel_open',
    description: 'Open a channel to start receiving messages',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string', description: 'ID of the channel to open' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'channel_close',
    description: 'Close a channel to stop receiving messages',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string', description: 'ID of the channel to close' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'channel_publish',
    description: 'Publish a message to a channel. If channelId is omitted, publishes to the most recent incoming channel.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string', description: 'ID of the channel to publish to (defaults to the most recent incoming channel)' },
        content: { type: 'string', description: 'Text content to publish' },
        text: { type: 'string', description: 'Alias for content' },
      },
      required: [],
    },
  },
];

// ============================================================================
// Constructor Options
// ============================================================================

interface ChannelRegistryOptions {
  /** Callback to determine whether an incoming message should trigger inference. */
  shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean;
}

// ============================================================================
// ChannelRegistry
// ============================================================================

export class ChannelRegistry {
  private serverRegistry: McplServerRegistry;
  private featureSetManager: FeatureSetManager;
  private pushEventFn: (event: ProcessEvent) => void;
  private emitTraceFn: (event: { type: string; [key: string]: unknown }) => void;
  private sendTypingFn?: (serverId: string, channelId: string) => void;
  private shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean;

  /** Registered channels, keyed by `{serverId}:{channelId}`. */
  private channels = new Map<string, ChannelEntry>();

  /** Most recent incoming channel ID — used for speech routing / default publish. */
  private defaultPublishChannel: string | null = null;

  /** Most recent incoming message metadata, used for buildChannelContext. */
  private defaultPublishMessageId: string | null = null;
  private defaultPublishThreadId: string | undefined = undefined;

  /** Per-channel typing indicator timers. */
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    serverRegistry: McplServerRegistry,
    featureSetManager: FeatureSetManager,
    pushEventFn: (event: ProcessEvent) => void,
    emitTraceFn: (event: { type: string; [key: string]: unknown }) => void,
    options?: ChannelRegistryOptions & {
      sendTypingFn?: (serverId: string, channelId: string) => void;
    },
  ) {
    this.serverRegistry = serverRegistry;
    this.featureSetManager = featureSetManager;
    this.pushEventFn = pushEventFn;
    this.emitTraceFn = emitTraceFn;
    this.sendTypingFn = options?.sendTypingFn;
    this.shouldTriggerInference = options?.shouldTriggerInference;
  }

  // ==========================================================================
  // Handler Methods (called from framework.ts wireMcplEvents)
  // ==========================================================================

  /**
   * Handle `channels/register` from a server.
   *
   * Registers each channel descriptor in the map and auto-opens them.
   */
  async handleRegister(
    serverId: string,
    params: ChannelsRegisterParams,
    responder?: Responder,
  ): Promise<void> {
    const registeredIds: string[] = [];

    for (const channel of params.channels) {
      const key = `${serverId}:${channel.id}`;
      this.channels.set(key, {
        serverId,
        descriptor: channel,
        open: false,
      });
      registeredIds.push(channel.id);
    }

    // Respond before auto-opening — the server blocks on this response and
    // can't process channels/open until it arrives.
    const result: ChannelsRegisterResult = { registered: registeredIds };
    responder?.respond(result);

    // Auto-open all registered channels
    await this.autoOpenChannels(serverId, params.channels);

    this.emitTraceFn({
      type: 'mcpl:channels-register',
      serverId,
      channelIds: registeredIds,
      count: registeredIds.length,
    });
  }

  /**
   * Handle `channels/changed` notification from a server.
   *
   * Processes added (register + auto-open), removed (delete + stop typing),
   * and updated (replace descriptor) channels.
   */
  async handleChanged(
    serverId: string,
    params: ChannelsChangedParams,
  ): Promise<void> {
    // Process removed channels
    if (params.removed) {
      for (const channelId of params.removed) {
        const key = `${serverId}:${channelId}`;
        this.channels.delete(key);
        this.stopTyping(channelId);
      }
    }

    // Process updated channels (replace descriptor, preserve open state)
    if (params.updated) {
      for (const channel of params.updated) {
        const key = `${serverId}:${channel.id}`;
        const existing = this.channels.get(key);
        if (existing) {
          existing.descriptor = channel;
        }
      }
    }

    // Process added channels (register + auto-open)
    if (params.added) {
      for (const channel of params.added) {
        const key = `${serverId}:${channel.id}`;
        this.channels.set(key, {
          serverId,
          descriptor: channel,
          open: false,
        });
      }
      await this.autoOpenChannels(serverId, params.added);
    }

    this.emitTraceFn({
      type: 'mcpl:channels-changed',
      serverId,
      added: params.added?.map((c) => c.id) ?? [],
      removed: params.removed ?? [],
      updated: params.updated?.map((c) => c.id) ?? [],
    });
  }

  /**
   * Handle `channels/incoming` from a server.
   *
   * Converts each message's content, pushes McplChannelIncomingEvent to the
   * queue, and responds with per-message results.
   */
  handleIncoming(
    serverId: string,
    params: ChannelsIncomingParams,
    responder?: Responder,
  ): void {
    const results: ChannelIncomingMessageResult[] = [];

    for (const message of params.messages) {
      // Convert MCPL content blocks to membrane ContentBlocks
      const convertedContent: ContentBlock[] = message.content.map(convertBlock);

      // Track default publish channel (most recent incoming)
      this.defaultPublishChannel = message.channelId;
      this.defaultPublishMessageId = message.messageId;
      this.defaultPublishThreadId = message.threadId;

      // Determine whether to trigger inference
      let triggerInference = true;
      if (this.shouldTriggerInference) {
        const textContent = message.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        triggerInference = this.shouldTriggerInference(
          textContent,
          {
            ...message.metadata,
            eventType: 'channel:incoming',
            serverId,
            channelId: message.channelId,
            messageId: message.messageId,
            threadId: message.threadId,
            author: message.author,
          },
        );
      }

      // Build the incoming event
      const event: McplChannelIncomingEvent = {
        type: 'mcpl:channel-incoming',
        serverId,
        channelId: message.channelId,
        messageId: message.messageId,
        threadId: message.threadId,
        author: message.author,
        content: convertedContent,
        timestamp: message.timestamp,
        metadata: message.metadata,
        triggerInference,
      };

      // Push to the processing queue
      // Cast through unknown because McplChannelIncomingEvent matches the
      // CustomEvent `${string}:${string}` type pattern but lacks an index signature.
      this.pushEventFn(event as unknown as ProcessEvent);

      // Collect per-message result
      results.push({
        messageId: message.messageId,
        accepted: true,
      });
    }

    const result: ChannelsIncomingResult = { results };
    responder?.respond(result);

    this.emitTraceFn({
      type: 'mcpl:channels-incoming',
      serverId,
      messageCount: params.messages.length,
      channelIds: [...new Set(params.messages.map((m) => m.channelId))],
    });
  }

  // ==========================================================================
  // Typing Indicator Management
  // ==========================================================================

  /**
   * Start sending typing indicators for a channel.
   *
   * Sends a typing notification immediately and every 7 seconds thereafter.
   * Discord typing indicators last ~10s, so 7s keeps them alive.
   *
   * No-op if already typing on this channel.
   */
  startTyping(channelId: string): void {
    if (this.typingIntervals.has(channelId)) {
      return; // Already typing
    }

    // Find the channel entry and its server
    const entry = this.findChannelEntry(channelId);
    if (!entry) {
      return;
    }

    // Send typing immediately
    this.sendTypingNotification(entry.serverId, channelId);

    // Set up interval
    const interval = setInterval(() => {
      this.sendTypingNotification(entry.serverId, channelId);
    }, TYPING_INTERVAL_MS);

    this.typingIntervals.set(channelId, interval);
  }

  /**
   * Stop sending typing indicators.
   *
   * If channelId is specified, stops typing on that channel only.
   * If no channelId, stops all typing indicators.
   */
  stopTyping(channelId?: string): void {
    if (channelId !== undefined) {
      const interval = this.typingIntervals.get(channelId);
      if (interval) {
        clearInterval(interval);
        this.typingIntervals.delete(channelId);
      }
    } else {
      // Clear all typing intervals
      for (const interval of this.typingIntervals.values()) {
        clearInterval(interval);
      }
      this.typingIntervals.clear();
    }
  }

  // ==========================================================================
  // Accessors
  // ==========================================================================

  /**
   * Get the default publish channel ID (most recent incoming channel).
   */
  getDefaultPublishChannel(): string | null {
    return this.defaultPublishChannel;
  }

  /**
   * Get all open channels.
   */
  getOpenChannels(): ChannelEntry[] {
    const result: ChannelEntry[] = [];
    for (const entry of this.channels.values()) {
      if (entry.open) {
        result.push(entry);
      }
    }
    return result;
  }

  // ==========================================================================
  // Synthesized Channel Tools
  // ==========================================================================

  /**
   * Get synthesized tool definitions for channel operations.
   */
  getChannelTools(): ToolDefinition[] {
    return CHANNEL_TOOL_DEFINITIONS;
  }

  /**
   * Handle a call to one of the synthesized channel tools.
   */
  async handleChannelToolCall(toolName: string, input: unknown): Promise<ToolResult> {
    switch (toolName) {
      case 'channel_list':
        return this.handleToolList();

      case 'channel_open':
        return this.handleToolOpen(input as { channelId: string });

      case 'channel_close':
        return this.handleToolClose(input as { channelId: string });

      case 'channel_publish':
        return this.handleToolPublish(input as { channelId: string; content: string });

      default:
        return { success: false, error: `Unknown channel tool: ${toolName}`, isError: true };
    }
  }

  // ==========================================================================
  // Channel Context for beforeInference
  // ==========================================================================

  /**
   * Build channel context for inclusion in beforeInference params.
   *
   * Returns undefined if no channels are active.
   */
  buildChannelContext(): ChannelContext | undefined {
    const openChannels = this.getOpenChannels();
    if (openChannels.length === 0 && !this.defaultPublishChannel) {
      return undefined;
    }

    const context: ChannelContext = {};

    // Incoming: from defaultPublishChannel if set
    if (this.defaultPublishChannel && this.defaultPublishMessageId) {
      context.incoming = {
        channelId: this.defaultPublishChannel,
        messageId: this.defaultPublishMessageId,
        threadId: this.defaultPublishThreadId,
      };
    }

    // Default outgoing: same as incoming (reply to last channel)
    if (this.defaultPublishChannel) {
      context.defaultOutgoing = {
        channelId: this.defaultPublishChannel,
      };
    }

    // Candidates: all open channel IDs
    if (openChannels.length > 0) {
      context.candidates = openChannels.map((e) => e.descriptor.id);
    }

    return context;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Stop all typing intervals and clear all channel registrations.
   */
  stopAll(): void {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Clear channels map
    this.channels.clear();

    // Reset default publish tracking
    this.defaultPublishChannel = null;
    this.defaultPublishMessageId = null;
    this.defaultPublishThreadId = undefined;
  }

  // ==========================================================================
  // Private: Auto-open channels
  // ==========================================================================

  private async autoOpenChannels(
    serverId: string,
    channels: ChannelDescriptor[],
  ): Promise<void> {
    const server = this.serverRegistry.getServer(serverId);
    if (!server) return;

    for (const channel of channels) {
      const key = `${serverId}:${channel.id}`;
      try {
        await server.sendChannelsOpen({
          type: channel.type,
          address: channel.address,
        });
        const entry = this.channels.get(key);
        if (entry) {
          entry.open = true;
        }
      } catch (err) {
        this.emitTraceFn({
          type: 'mcpl:channel-open-failed',
          serverId,
          channelId: channel.id,
          error: (err as Error).message,
        });
      }
    }
  }

  // ==========================================================================
  // Private: Typing notification
  // ==========================================================================

  /**
   * Send a typing notification for a channel.
   *
   * Uses the sendTypingFn callback if provided. If not, this is a no-op
   * (typing timer lifecycle is still managed for when the callback is wired).
   */
  private sendTypingNotification(serverId: string, channelId: string): void {
    if (this.sendTypingFn) {
      this.sendTypingFn(serverId, channelId);
    }
    // TODO: When server-connection exposes a public sendNotification or
    // sendTyping method, wire it here directly instead of using a callback.
  }

  // ==========================================================================
  // Private: Channel Lookup
  // ==========================================================================

  /**
   * Find a channel entry by channelId (searches across all servers).
   * Returns the first match.
   */
  private findChannelEntry(channelId: string): ChannelEntry | undefined {
    for (const [key, entry] of this.channels) {
      if (entry.descriptor.id === channelId) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Find the composite key for a channel by its channelId.
   */
  private findChannelKey(channelId: string): string | undefined {
    for (const [key, entry] of this.channels) {
      if (entry.descriptor.id === channelId) {
        return key;
      }
    }
    return undefined;
  }

  // ==========================================================================
  // Private: Tool Handlers
  // ==========================================================================

  private handleToolList(): ToolResult {
    const allChannels: Array<{
      id: string;
      type: string;
      label: string;
      direction: string;
      open: boolean;
      serverId: string;
    }> = [];

    for (const entry of this.channels.values()) {
      allChannels.push({
        id: entry.descriptor.id,
        type: entry.descriptor.type,
        label: entry.descriptor.label,
        direction: entry.descriptor.direction,
        open: entry.open,
        serverId: entry.serverId,
      });
    }

    return {
      success: true,
      data: allChannels,
    };
  }

  private async handleToolOpen(input: { channelId: string }): Promise<ToolResult> {
    const entry = this.findChannelEntry(input.channelId);
    if (!entry) {
      return {
        success: false,
        error: `Channel not found: ${input.channelId}`,
        isError: true,
      };
    }

    if (entry.open) {
      return {
        success: true,
        data: { channelId: input.channelId, status: 'already open' },
      };
    }

    const server = this.serverRegistry.getServer(entry.serverId);
    if (!server) {
      return {
        success: false,
        error: `Server not found: ${entry.serverId}`,
        isError: true,
      };
    }

    try {
      await server.sendChannelsOpen({
        type: entry.descriptor.type,
        address: entry.descriptor.address,
      });
      entry.open = true;
      return {
        success: true,
        data: { channelId: input.channelId, status: 'opened' },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to open channel: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  private async handleToolClose(input: { channelId: string }): Promise<ToolResult> {
    const entry = this.findChannelEntry(input.channelId);
    if (!entry) {
      return {
        success: false,
        error: `Channel not found: ${input.channelId}`,
        isError: true,
      };
    }

    if (!entry.open) {
      return {
        success: true,
        data: { channelId: input.channelId, status: 'already closed' },
      };
    }

    const server = this.serverRegistry.getServer(entry.serverId);
    if (!server) {
      return {
        success: false,
        error: `Server not found: ${entry.serverId}`,
        isError: true,
      };
    }

    try {
      await server.sendChannelsClose({ channelId: input.channelId });
      entry.open = false;
      this.stopTyping(input.channelId);
      return {
        success: true,
        data: { channelId: input.channelId, status: 'closed' },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to close channel: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  private async handleToolPublish(input: { channelId?: string; content?: string; text?: string }): Promise<ToolResult> {
    // Resolve content: accept both `content` and `text` (backward compat)
    const messageText = input.content ?? input.text;
    if (!messageText) {
      return {
        success: false,
        error: 'Either content or text parameter is required',
        isError: true,
      };
    }

    // Resolve channelId: default to most recent incoming channel
    const channelId = input.channelId ?? this.defaultPublishChannel;
    if (!channelId) {
      return {
        success: false,
        error: 'No channelId specified and no default channel available',
        isError: true,
      };
    }

    const entry = this.findChannelEntry(channelId);
    if (!entry) {
      return {
        success: false,
        error: `Channel not found: ${channelId}`,
        isError: true,
      };
    }

    const server = this.serverRegistry.getServer(entry.serverId);
    if (!server) {
      return {
        success: false,
        error: `Server not found: ${entry.serverId}`,
        isError: true,
      };
    }

    try {
      const publishParams: ChannelsPublishParams = {
        conversationId: '', // Framework will fill this when wired
        channelId,
        content: [{ type: 'text', text: messageText }],
      };

      const result = await server.sendChannelsPublish(publishParams);
      return {
        success: true,
        data: result ?? { delivered: true },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to publish to channel: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
