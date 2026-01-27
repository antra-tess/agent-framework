/**
 * Types for the Discord module
 */

// ============================================================================
// Module Configuration
// ============================================================================

export interface DiscordModuleConfig {
  /** Discord bot token */
  token: string;

  /** Guild IDs to listen to (optional, defaults to all guilds the bot is in) */
  guildIds?: string[];

  /** Channel IDs to listen to (optional, defaults to all channels) */
  channelIds?: string[];

  /** Whether to handle DMs (default: true) */
  handleDMs?: boolean;

  /** Prefix for commands (optional, e.g., '!' or '/') */
  commandPrefix?: string;

  /** Whether to ignore bot messages (default: true) */
  ignoreBots?: boolean;

  /** Rate limit: max messages per minute per channel (default: 30) */
  rateLimitPerMinute?: number;
}

// ============================================================================
// Module State
// ============================================================================

export interface DiscordModuleState {
  /** Currently connected guild IDs */
  connectedGuilds: string[];

  /** Active conversation contexts */
  conversations: Record<string, ConversationContext>;

  /** Rate limit tracking */
  rateLimits: Record<string, RateLimitInfo>;
}

export interface ConversationContext {
  /** Channel ID for replies */
  channelId: string;

  /** Thread ID if in a thread */
  threadId?: string;

  /** Message ID to reply to */
  replyToMessageId?: string;

  /** User who started the conversation */
  userId: string;

  /** Guild ID (null for DMs) */
  guildId: string | null;

  /** Last activity timestamp */
  lastActivity: number;
}

export interface RateLimitInfo {
  /** Messages sent in current window */
  count: number;

  /** Window start timestamp */
  windowStart: number;
}

// ============================================================================
// Tool Inputs
// ============================================================================

export interface SendInput {
  /** Channel ID to send to */
  channelId: string;

  /** Content to send */
  content: string;

  /** Whether to create a thread (optional) */
  createThread?: {
    name: string;
  };

  /** Message ID to reply to (optional) */
  replyTo?: string;
}

export interface SendDMInput {
  /** User ID to DM */
  userId: string;

  /** Content to send */
  content: string;
}

export interface ReplyInput {
  /** Content to send */
  content: string;

  /** Whether to mention the user (default: false) */
  mention?: boolean;
}

export interface ReactInput {
  /** Channel ID containing the message */
  channelId: string;

  /** Message ID to react to */
  messageId: string;

  /** Emoji to react with (unicode or custom emoji ID) */
  emoji: string;
}

export interface EditMessageInput {
  /** Channel ID containing the message */
  channelId: string;

  /** Message ID to edit */
  messageId: string;

  /** New content */
  content: string;
}

export interface DeleteMessageInput {
  /** Channel ID containing the message */
  channelId: string;

  /** Message ID to delete */
  messageId: string;
}

export interface CreateThreadInput {
  /** Channel ID to create thread in */
  channelId: string;

  /** Message ID to start thread from */
  messageId: string;

  /** Thread name */
  name: string;

  /** Auto-archive duration in minutes (60, 1440, 4320, 10080) */
  autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
}

export interface SetReplyContextInput {
  /** Channel ID for future replies */
  channelId: string;

  /** Thread ID (optional) */
  threadId?: string;

  /** Message ID to reply to (optional) */
  replyToMessageId?: string;
}

// ============================================================================
// Discord Events (internal)
// ============================================================================

export interface DiscordMessageData {
  /** Discord message ID */
  id: string;

  /** Channel ID */
  channelId: string;

  /** Guild ID (null for DMs) */
  guildId: string | null;

  /** Author user ID */
  authorId: string;

  /** Author username */
  authorName: string;

  /** Message content */
  content: string;

  /** Whether this is a reply */
  isReply: boolean;

  /** ID of message being replied to */
  replyToId?: string;

  /** Attachments */
  attachments: DiscordAttachment[];

  /** Timestamp */
  timestamp: Date;
}

export interface DiscordAttachment {
  /** Attachment ID */
  id: string;

  /** Filename */
  filename: string;

  /** URL */
  url: string;

  /** Content type */
  contentType?: string;

  /** Size in bytes */
  size: number;
}

// ============================================================================
// Discord Custom Events (for event queue)
// ============================================================================

/**
 * Custom event for new Discord messages.
 * Pushed to queue by callbacks, processed in onProcess().
 */
export interface DiscordMessageEvent {
  type: 'discord:message';
  discordMessageId: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: Date;
  attachments: DiscordAttachment[];
  [key: string]: unknown; // Required for CustomEvent compatibility
}

/**
 * Custom event for Discord message edits.
 */
export interface DiscordEditEvent {
  type: 'discord:edit';
  discordMessageId: string;
  newContent: string;
  [key: string]: unknown;
}

/**
 * Custom event for Discord message deletions.
 */
export interface DiscordDeleteEvent {
  type: 'discord:delete';
  discordMessageId: string;
  [key: string]: unknown;
}

/**
 * Union of all Discord custom events.
 */
export type DiscordEvent = DiscordMessageEvent | DiscordEditEvent | DiscordDeleteEvent;

// ============================================================================
// Discord Client Interface (for abstraction)
// ============================================================================

/**
 * Abstract interface for Discord client operations.
 * Allows for real discord.js client or mock for testing.
 */
export interface DiscordClientInterface {
  /** Connect to Discord */
  connect(): Promise<void>;

  /** Disconnect from Discord */
  disconnect(): Promise<void>;

  /** Send a message to a channel */
  sendMessage(
    channelId: string,
    content: string,
    options?: {
      replyTo?: string;
      createThread?: { name: string };
    }
  ): Promise<{ messageId: string }>;

  /** Send a DM to a user */
  sendDM(userId: string, content: string): Promise<{ messageId: string }>;

  /** Edit a message */
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;

  /** Delete a message */
  deleteMessage(channelId: string, messageId: string): Promise<void>;

  /** Add a reaction */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;

  /** Create a thread */
  createThread(
    channelId: string,
    messageId: string,
    name: string,
    autoArchiveDuration?: number
  ): Promise<{ threadId: string }>;

  /** Register message handler */
  onMessage(handler: (message: DiscordMessageData) => void): void;

  /** Register message edit handler */
  onMessageEdit(handler: (messageId: string, newContent: string) => void): void;

  /** Register message delete handler */
  onMessageDelete(handler: (messageId: string) => void): void;

  /** Check if connected */
  isConnected(): boolean;
}
