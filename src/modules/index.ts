/**
 * Built-in modules for the agent framework
 */

export { ApiModule } from './api/index.js';
export type { ApiEvent } from './api/index.js';

export { FilesModule } from './files/index.js';
export type {
  FilesModuleConfig,
  WorkspaceIndex,
  FileEntry,
  ContentLogEntry,
  ReadInput,
  WriteInput,
  EditInput,
  GlobInput,
  GrepInput,
  MaterializeInput,
  SyncInput,
} from './files/index.js';

export { DiscordModule, DiscordJsClient } from './discord/index.js';
export type { DiscordJsClientConfig } from './discord/index.js';
export type {
  DiscordModuleConfig,
  DiscordModuleState,
  ConversationContext,
  DiscordClientInterface,
  DiscordMessageData,
  DiscordAttachment,
  SendInput as DiscordSendInput,
  SendDMInput,
  ReplyInput,
  ReactInput,
  EditMessageInput,
  DeleteMessageInput,
  CreateThreadInput,
  SetReplyContextInput,
} from './discord/index.js';
