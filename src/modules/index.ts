/**
 * Built-in modules for the agent framework
 */

export { ApiModule } from './api/index.js';
export type { ApiEvent } from './api/index.js';

export { HealthModule } from './health/index.js';
export type { HealthModuleConfig } from './health/index.js';

export { WorkspaceModule } from './workspace/index.js';
export type {
  WorkspaceConfig,
  MountConfig,
  MountState,
  WorkspaceModuleState,
  ReadInput,
  WriteInput,
  EditInput,
  DeleteInput,
  LsInput,
  GlobInput,
  GrepInput,
  StatusInput,
  MaterializeInput,
  SyncInput,
} from './workspace/index.js';

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
