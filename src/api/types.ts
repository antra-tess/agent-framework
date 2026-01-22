/**
 * API types for WebSocket communication with the agent framework
 */

import type { ContentBlock } from 'membrane';
import type { AgentStatus, ToolCall, ToolResult } from '../types/index.js';

// ============================================================================
// Protocol
// ============================================================================

/**
 * Base message structure for all API communication.
 */
export interface ApiMessage {
  /** Message type */
  type: string;
  /** Request ID for correlation (client provides, server echoes) */
  id?: string;
}

/**
 * Request from client to server.
 */
export interface ApiRequest extends ApiMessage {
  type: 'request';
  /** Command to execute */
  command: string;
  /** Command parameters */
  params?: Record<string, unknown>;
}

/**
 * Response from server to client.
 */
export interface ApiResponse extends ApiMessage {
  type: 'response';
  /** Whether the request succeeded */
  success: boolean;
  /** Response data (if success) */
  data?: unknown;
  /** Error message (if failure) */
  error?: string;
}

/**
 * Event from server to client.
 */
export interface ApiEvent extends ApiMessage {
  type: 'event';
  /** Event name */
  event: string;
  /** Event data */
  data: unknown;
}

// ============================================================================
// Commands
// ============================================================================

export type ApiCommand =
  // Conversation
  | 'message.send'
  | 'message.list'
  | 'inference.request'
  // Branching
  | 'branch.list'
  | 'branch.create'
  | 'branch.switch'
  | 'branch.current'
  | 'branch.delete'
  // Inspection
  | 'agent.list'
  | 'agent.context'
  | 'module.list'
  | 'module.state'
  | 'store.states'
  | 'store.inspect'
  | 'store.search'
  // Subscriptions
  | 'store.subscribe'
  | 'store.unsubscribe'
  // Inference logs
  | 'inference.tail'
  | 'inference.inspect'
  | 'inference.search'
  // Event logs
  | 'events.tail'
  | 'events.inspect'
  | 'events.search'
  | 'events.subscribe';

// ============================================================================
// Command Parameters
// ============================================================================

export interface MessageSendParams {
  /** Participant name (who is sending) */
  participant: string;
  /** Message content (text) */
  content: string;
  /** Whether to trigger inference after (default: true) */
  triggerInference?: boolean;
  /** Specific agents to trigger */
  targetAgents?: string[];
}

export interface MessageListParams {
  /** Maximum number of messages to return */
  limit?: number;
  /** Offset from end (0 = most recent) */
  offset?: number;
}

export interface InferenceRequestParams {
  /** Agent to run inference for (or all if not specified) */
  agentName?: string;
  /** Reason for the request */
  reason?: string;
}

export interface BranchCreateParams {
  /** Name for the new branch */
  name: string;
  /** Whether to switch to the new branch (default: false) */
  switchTo?: boolean;
}

export interface BranchSwitchParams {
  /** Branch name to switch to */
  name: string;
}

export interface BranchDeleteParams {
  /** Branch name to delete */
  name: string;
}

export interface AgentContextParams {
  /** Agent name */
  agentName: string;
  /** Maximum tokens to include (optional) */
  maxTokens?: number;
}

export interface ModuleStateParams {
  /** Module name */
  moduleName: string;
}

export interface StoreInspectParams {
  /** State ID to inspect */
  stateId: string;
}

export interface StoreStatesParams {
  /** Filter by namespace prefix (e.g., 'agents/', 'modules/') */
  namespace?: string;
  /** Maximum number of states to return (default: 50) */
  limit?: number;
}

export interface StoreSearchParams {
  /** Filter by namespace prefix */
  namespace?: string;
  /** Regex pattern to match against state content (JSON stringified) */
  contentPattern?: string;
  /** Maximum number of results (default: 20) */
  limit?: number;
  /** Skip first N results for pagination (default: 0) */
  offset?: number;
  /** Preview length in characters (default: 300) */
  previewLength?: number;
}

export interface InferenceTailParams {
  /** Number of recent entries to return (default: 10) */
  count?: number;
  /** Filter by agent name */
  agentName?: string;
}

export interface InferenceInspectParams {
  /** Sequence number of the log entry to inspect */
  sequence: number;
}

export interface InferenceSearchParams {
  /** Filter by agent name */
  agentName?: string;
  /** Maximum number of results (default: 20) */
  limit?: number;
  /** Skip first N results for pagination (default: 0) */
  offset?: number;
  /** Regex pattern to match against log content */
  pattern?: string;
  /** Only show failed inferences */
  errorsOnly?: boolean;
}

// --- Event Log Parameters ---

export interface EventsTailParams {
  /** Number of recent entries to return (default: 10) */
  count?: number;
  /** Filter by event type */
  eventType?: string;
}

export interface EventsInspectParams {
  /** Sequence number of the log entry to inspect */
  sequence: number;
}

export interface EventsSearchParams {
  /** Filter by event type */
  eventType?: string;
  /** Filter by module name */
  moduleName?: string;
  /** Maximum number of results (default: 20) */
  limit?: number;
  /** Skip first N results for pagination (default: 0) */
  offset?: number;
  /** Regex pattern to match against log content */
  pattern?: string;
}

export interface EventsSubscribeParams {
  /** Event type patterns to subscribe to (e.g., 'inference:*', 'tool:*') */
  types?: string[];
  /** Maximum number of historical events to return (default: 100) */
  limit?: number;
}

export interface PersistedEvent {
  /** Unique event ID */
  id: string;
  /** Sequence number in the event log */
  sequence?: number;
  /** Event timestamp */
  timestamp: number;
  /** Event type */
  type: string;
  /** Event payload */
  payload: unknown;
  /** Source of the event */
  source: string;
  /** ID of event that caused this one */
  causedBy?: string;
  /** Agent name (if applicable) */
  agentName?: string;
  /** Module name (if applicable) */
  moduleName?: string;
}

// --- Subscription Parameters ---

export interface StoreSubscribeParams {
  /** Max buffered events before dropping (default: 1000) */
  bufferSize?: number;
  /** Max bytes for state snapshots (default: 10MB) */
  maxSnapshotBytes?: number;
  /** Starting sequence for catch-up (undefined = live only) */
  fromSequence?: number;
  /** Filter configuration */
  filter?: SubscriptionFilterParams;
}

export interface SubscriptionFilterParams {
  /** Filter by record types (undefined = all) */
  recordTypes?: string[];
  /** Filter by branch name */
  branch?: string;
  /** Subscribe to specific state IDs */
  stateIds?: string[];
  /** Include record events (default: false) */
  includeRecords?: boolean;
  /** Include state change events (default: false) */
  includeStateChanges?: boolean;
  /** Include branch events (default: false) */
  includeBranchEvents?: boolean;
}

export interface StoreUnsubscribeParams {
  /** Subscription ID to remove */
  subscriptionId: string;
}

// ============================================================================
// Response Data
// ============================================================================

export interface MessageInfo {
  /** Internal message ID */
  id: string;
  /** Participant name */
  participant: string;
  /** Content blocks */
  content: ContentBlock[];
  /** Timestamp */
  timestamp?: Date;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

export interface BranchInfo {
  /** Branch name */
  name: string;
  /** Whether this is the current branch */
  isCurrent: boolean;
  /** Parent branch name */
  parent?: string;
  /** Creation timestamp */
  createdAt?: number;
}

export interface AgentInfo {
  /** Agent name */
  name: string;
  /** Model */
  model: string;
  /** Current status */
  status: AgentStatus;
  /** System prompt (truncated) */
  systemPromptPreview: string;
  /** Allowed tools */
  allowedTools: 'all' | string[];
}

export interface ModuleInfo {
  /** Module name */
  name: string;
  /** Available tools */
  tools: string[];
}

export interface StateInfo {
  /** State ID */
  id: string;
  /** Strategy */
  strategy: string;
  /** Has data */
  hasData: boolean;
}

// ============================================================================
// Events
// ============================================================================

export type ApiEventType =
  // Framework events
  | 'inference:start'
  | 'inference:complete'
  | 'inference:error'
  | 'tool:start'
  | 'tool:complete'
  | 'tool:error'
  | 'event:handled'
  | 'speech'
  | 'message:added'
  | 'message:edited'
  | 'message:removed'
  // Branch events
  | 'branch:switched'
  | 'branch:created'
  | 'branch:deleted'
  // Module events
  | 'module:started'
  | 'module:stopped'
  // Store subscription events
  | 'store:record'
  | 'store:state_snapshot'
  | 'store:state_delta'
  | 'store:branch_head'
  | 'store:branch_created'
  | 'store:branch_deleted'
  | 'store:caught_up'
  | 'store:dropped';

export interface InferenceStartEvent {
  agentName: string;
}

export interface InferenceCompleteEvent {
  agentName: string;
  durationMs: number;
}

export interface InferenceErrorEvent {
  agentName: string;
  error: string;
}

export interface ToolStartEvent {
  moduleName: string;
  toolName: string;
  callId: string;
}

export interface ToolCompleteEvent {
  moduleName: string;
  toolName: string;
  callId: string;
  durationMs: number;
}

export interface ToolErrorEvent {
  moduleName: string;
  toolName: string;
  callId: string;
  error: string;
}

export interface SpeechEvent {
  agentName: string;
  content: ContentBlock[];
  turnComplete: boolean;
}

export interface MessageAddedEvent {
  messageId: string;
  participant: string;
  content: ContentBlock[];
}

export interface MessageEditedEvent {
  messageId: string;
  newContent: ContentBlock[];
}

export interface MessageRemovedEvent {
  messageId: string;
}

export interface BranchSwitchedEvent {
  from: string;
  to: string;
}

export interface BranchCreatedEvent {
  name: string;
  parent: string;
}

export interface BranchDeletedEvent {
  name: string;
}

// --- Store Subscription Events ---

export interface StoreRecordEvent {
  subscriptionId: string;
  record: {
    id: number;
    sequence: number;
    branch: number;
    recordType: string;
    timestamp: number;
    payloadSize: number;
    payload?: unknown;
  };
}

export interface StoreStateSnapshotEvent {
  subscriptionId: string;
  stateId: string;
  data: unknown;
  sequence: number;
  truncated: boolean;
  totalBytes: number;
  fromIndex?: number;
  totalLength?: number;
}

export interface StoreStateDeltaEvent {
  subscriptionId: string;
  stateId: string;
  operation: unknown;
  sequence: number;
}

export interface StoreBranchHeadEvent {
  subscriptionId: string;
  branch: string;
  head: number;
}

export interface StoreBranchCreatedEvent {
  subscriptionId: string;
  branch: {
    id: number;
    name: string;
    head: number;
    parent?: string;
    branchPoint?: number;
    created: number;
  };
}

export interface StoreBranchDeletedEvent {
  subscriptionId: string;
  name: string;
}

export interface StoreCaughtUpEvent {
  subscriptionId: string;
}

export interface StoreDroppedEvent {
  subscriptionId: string;
  reason: string;
}

// ============================================================================
// Server Configuration
// ============================================================================

export interface ApiServerConfig {
  /** Port to listen on (default: 8765) */
  port?: number;
  /** Host to bind to (default: 'localhost') */
  host?: string;
  /** Path for WebSocket endpoint (default: '/ws') */
  path?: string;
  /** Enable HTTP endpoints alongside WebSocket (default: true) */
  enableHttp?: boolean;
}
