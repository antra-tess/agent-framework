/**
 * Discord.js client adapter implementing DiscordClientInterface
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  DMChannel,
  type Message,
} from 'discord.js';
import type { DiscordClientInterface, DiscordMessageData, DiscordAttachment } from './types.js';

export interface DiscordJsClientConfig {
  token: string;
  guildIds?: string[];
  channelIds?: string[];
}

export class DiscordJsClient implements DiscordClientInterface {
  private client: Client;
  private token: string;
  private guildIds?: string[];
  private channelIds?: string[];

  private messageHandler?: (message: DiscordMessageData) => void;
  private editHandler?: (messageId: string, newContent: string) => void;
  private deleteHandler?: (messageId: string) => void;

  constructor(config: DiscordJsClientConfig) {
    this.token = config.token;
    this.guildIds = config.guildIds;
    this.channelIds = config.channelIds;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on('messageCreate', (message) => {
      if (!this.shouldHandleMessage(message)) return;
      if (this.messageHandler) {
        this.messageHandler(this.convertMessage(message));
      }
    });

    this.client.on('messageUpdate', (_oldMessage, newMessage) => {
      if (!newMessage.content || !this.editHandler) return;
      this.editHandler(newMessage.id, newMessage.content);
    });

    this.client.on('messageDelete', (message) => {
      if (this.deleteHandler) {
        this.deleteHandler(message.id);
      }
    });

    this.client.on('ready', () => {
      console.log(`[Discord] Logged in as ${this.client.user?.tag}`);
    });

    this.client.on('error', (error) => {
      console.error('[Discord] Client error:', error);
    });
  }

  private shouldHandleMessage(message: Message): boolean {
    // Never process our own messages (prevents feedback loop)
    if (message.author.id === this.client.user?.id) {
      return false;
    }

    // Filter by guild
    if (this.guildIds && this.guildIds.length > 0) {
      if (!message.guildId || !this.guildIds.includes(message.guildId)) {
        return false;
      }
    }

    // Filter by channel
    if (this.channelIds && this.channelIds.length > 0) {
      if (!this.channelIds.includes(message.channelId)) {
        return false;
      }
    }

    return true;
  }

  private convertMessage(message: Message): DiscordMessageData {
    const attachments: DiscordAttachment[] = message.attachments.map((a) => ({
      id: a.id,
      filename: a.name ?? 'unknown',
      url: a.url,
      contentType: a.contentType ?? undefined,
      size: a.size,
    }));

    return {
      id: message.id,
      content: message.content,
      authorId: message.author.id,
      authorName: message.author.username,
      channelId: message.channelId,
      guildId: message.guildId ?? null,
      isReply: message.reference !== null,
      replyToId: message.reference?.messageId ?? undefined,
      attachments,
      timestamp: message.createdAt,
    };
  }

  async connect(): Promise<void> {
    await this.client.login(this.token);
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  isConnected(): boolean {
    return this.client.isReady();
  }

  async sendMessage(
    channelId: string,
    content: string,
    options?: { replyTo?: string; createThread?: { name: string } }
  ): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Channel ${channelId} not found or not a text channel`);
    }

    const textChannel = channel as TextChannel | DMChannel;
    const message = await textChannel.send({
      content,
      reply: options?.replyTo ? { messageReference: options.replyTo } : undefined,
    });

    if (options?.createThread && 'threads' in textChannel) {
      await message.startThread({ name: options.createThread.name });
    }

    return { messageId: message.id };
  }

  async sendDM(userId: string, content: string): Promise<{ messageId: string }> {
    const user = await this.client.users.fetch(userId);
    const message = await user.send(content);
    return { messageId: message.id };
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const message = await (channel as TextChannel).messages.fetch(messageId);
    await message.edit(content);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const message = await (channel as TextChannel).messages.fetch(messageId);
    await message.delete();
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const message = await (channel as TextChannel).messages.fetch(messageId);
    await message.react(emoji);
  }

  async createThread(
    channelId: string,
    messageId: string,
    name: string,
    autoArchiveDuration?: number
  ): Promise<{ threadId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const message = await (channel as TextChannel).messages.fetch(messageId);
    const thread = await message.startThread({
      name,
      autoArchiveDuration: (autoArchiveDuration as 60 | 1440 | 4320 | 10080) ?? 1440,
    });
    return { threadId: thread.id };
  }

  onMessage(handler: (message: DiscordMessageData) => void): void {
    this.messageHandler = handler;
  }

  onMessageEdit(handler: (messageId: string, newContent: string) => void): void {
    this.editHandler = handler;
  }

  onMessageDelete(handler: (messageId: string) => void): void {
    this.deleteHandler = handler;
  }
}
