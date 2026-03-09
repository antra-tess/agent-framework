// Types
export * from './types/index.js';

// Core classes
export { AgentFramework } from './framework.js';
export { Agent } from './agent.js';
export type { StartStreamResult } from './agent.js';
export { ProcessQueueImpl } from './queue.js';
export { ModuleRegistry } from './module-registry.js';

// Built-in modules
export * from './modules/index.js';

// API
export { ApiServer } from './api/server.js';
export { McpServer } from './api/mcp-server.js';
export type {
  ApiServerConfig,
  ApiMessage,
  ApiRequest,
  ApiResponse,
  ApiEvent,
  ApiCommand,
  MessageSendParams,
  MessageListParams,
  InferenceRequestParams,
  BranchCreateParams,
  BranchSwitchParams,
  BranchDeleteParams,
  AgentContextParams,
  ModuleStateParams,
  StoreInspectParams,
  MessageInfo,
  BranchInfo,
  ModuleInfo,
  StateInfo,
  ApiEventType,
  InferenceStartEvent,
  InferenceCompleteEvent,
  InferenceErrorEvent,
  ToolStartEvent,
  ToolCompleteEvent,
  ToolErrorEvent,
  SpeechEvent,
  MessageAddedEvent,
  BranchSwitchedEvent,
  BranchCreatedEvent,
  BranchDeletedEvent,
} from './api/types.js';
// Note: AgentInfo, MessageEditedEvent, MessageRemovedEvent intentionally not re-exported
// from api/types.js to avoid conflicts with ./types/index.js

// Re-export commonly used types from dependencies
export type { ContextManager, ContextStrategy, TokenBudget } from '@connectome/context-manager';
export { PassthroughStrategy, AutobiographicalStrategy, KnowledgeStrategy } from '@connectome/context-manager';
export type { KnowledgeConfig, PhaseType } from '@connectome/context-manager';
export type { Membrane, NormalizedMessage, NormalizedRequest, ContentBlock } from 'membrane';
