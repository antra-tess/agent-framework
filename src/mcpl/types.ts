/**
 * MCPL (MCP Live) Protocol Types — v0.4.0-draft
 *
 * Type definitions for the host-side implementation of the MCPL protocol.
 * Organized by spec section for easy cross-referencing with mcpl/SPEC.md.
 *
 * Naming conventions:
 *   - Types prefixed with `Mcpl` when they collide with existing framework/membrane
 *     types (e.g., McplContentBlock vs membrane's ContentBlock, McplModelInfo vs
 *     membrane's ModelInfo, McplInferenceRequestParams vs API's InferenceRequestParams).
 *   - All other types use plain names — they live in the mcpl/ module and are
 *     unambiguous when imported from here.
 */

// ============================================================================
// JSON-RPC 2.0 (Transport Layer)
// ============================================================================

/**
 * JSON-RPC 2.0 request. Notifications omit `id`.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  id?: string | number;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 successful response.
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 error object.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ============================================================================
// Section 4 — MCPL Content Blocks (Wire Format)
// ============================================================================
// These represent content as it travels over the MCPL protocol.
// They differ from membrane's ContentBlock (which is LLM-provider-oriented).
// Conversion between McplContentBlock and membrane ContentBlock happens in
// the host when bridging protocol ↔ inference pipeline.

export type McplContentBlock =
  | McplTextContent
  | McplImageContent
  | McplAudioContent
  | McplResourceContent;

export interface McplTextContent {
  type: 'text';
  text: string;
}

export interface McplImageContent {
  type: 'image';
  /** Base64-encoded image data (present when using inline form) */
  data?: string;
  /** MIME type (present when using inline form) */
  mimeType?: string;
  /** URI reference (present when using URI form) */
  uri?: string;
}

export interface McplAudioContent {
  type: 'audio';
  /** Base64-encoded audio data (present when using inline form) */
  data?: string;
  /** MIME type (present when using inline form) */
  mimeType?: string;
  /** URI reference (present when using URI form) */
  uri?: string;
}

export interface McplResourceContent {
  type: 'resource';
  /** Resource URI (e.g., "memory://facts/12345") */
  uri: string;
}

// ============================================================================
// Section 5 — Capability Negotiation
// ============================================================================

/**
 * MCPL capabilities as advertised by a server in `experimental.mcpl`.
 * Parsed from the server's `initialize` response.
 */
export interface McplCapabilities {
  /** MCPL protocol version (e.g., "0.4") */
  version: string;

  /** Server supports push/event */
  pushEvents?: boolean;

  /** Context hook capabilities */
  contextHooks?: {
    beforeInference?: boolean;
    afterInference?: boolean | { blocking: boolean };
  };

  /** Server-initiated inference capabilities */
  inferenceRequest?: {
    streaming?: boolean;
  };

  /** Server supports model/info requests */
  modelInfo?: boolean;

  /** Declared feature sets (keyed by feature set name) */
  featureSets?: Record<string, FeatureSetDeclaration>;

  /** Channel capabilities */
  channels?: McplChannelCapabilities;
}

/**
 * MCPL capabilities that the host advertises to servers.
 * Sent in the host's `initialize` response under `capabilities.experimental.mcpl`.
 */
export interface McplHostCapabilities {
  version: string;
  pushEvents?: boolean;
  contextHooks?: {
    beforeInference?: boolean;
    afterInference?: boolean | { blocking: boolean };
  };
  inferenceRequest?: {
    streaming?: boolean;
  };
  featureSets?: boolean;
  channels?: McplChannelCapabilities;
}

/** Channel-specific capability flags. */
export interface McplChannelCapabilities {
  register?: boolean;
  publish?: boolean;
  observe?: boolean;
  lifecycle?: boolean;
  streaming?: boolean;
}

// ============================================================================
// Section 5 — Server Configuration (Host-Side)
// ============================================================================

/**
 * Configuration for connecting to a single MCPL server.
 * Provided in FrameworkConfig.mcplServers[].
 */
export interface McplServerConfig {
  /** Unique server identifier */
  id: string;

  /** Command to spawn the server process (stdio transport) */
  command: string;

  /** Arguments for the command */
  args?: string[];

  /** Environment variables for the child process */
  env?: Record<string, string>;

  /** Feature sets to enable on connect */
  enabledFeatureSets?: string[];

  /** Feature sets to explicitly disable on connect */
  disabledFeatureSets?: string[];

  /** Scope configurations per feature set */
  scopes?: Record<string, ScopeConfig>;

  /**
   * Enable automatic reconnection on unexpected disconnect or handshake failure.
   * When true, connect() resolves immediately (with null capabilities) if the
   * server is unavailable, and retries in the background.
   * Adapted from Anarchid/agent-framework@mcpl-module-proto.
   */
  reconnect?: boolean;

  /**
   * Interval between reconnection attempts in milliseconds.
   * Default: 5000 (5 seconds).
   */
  reconnectIntervalMs?: number;

  /**
   * Optional callback to filter which incoming channel messages should trigger
   * agent inference. Receives the text content and message metadata.
   * Return true to trigger inference, false to silently accept the message.
   *
   * Common metadata fields servers may provide:
   * - mentionIds: string[] — user IDs mentioned in the message
   * - replyToAuthorId: string — user ID of the author being replied to
   * - botUserId: string — the server's bot/self user ID
   *
   * If not provided, all incoming messages trigger inference.
   */
  shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean;
}

// ============================================================================
// Section 6 — Feature Sets
// ============================================================================

/** What a feature set can use. Maps to spec Section 6.2. */
export type FeatureSetUse =
  | 'pushEvents'
  | 'contextHooks.beforeInference'
  | 'contextHooks.afterInference'
  | 'inferenceRequest'
  | 'tools'
  | 'channels.publish'
  | 'channels.observe';

/**
 * A feature set declaration as advertised by a server.
 * Spec Section 6.1.
 */
export interface FeatureSetDeclaration {
  /** Human-readable description */
  description: string;

  /** Capabilities this feature set uses */
  uses: FeatureSetUse[];

  /** Whether this feature set uses scoped access (Section 7) */
  scoped?: boolean;

  /** Whether server supports rollback for this feature set (Section 8.1) */
  rollback?: boolean;

  /** Whether host manages state persistence for this feature set (Section 8.1) */
  hostState?: boolean;
}

/**
 * featureSets/update params (Host → Server, Notification).
 * Spec Section 6.7.
 */
export interface FeatureSetsUpdateParams {
  /** Feature sets to enable */
  enabled?: string[];

  /** Feature sets to disable */
  disabled?: string[];

  /** Scope configurations per feature set */
  scopes?: Record<string, ScopeConfig>;
}

/**
 * featureSets/changed params (Server → Host, Notification).
 * Spec Section 6.7.
 */
export interface FeatureSetsChangedParams {
  /** Newly available feature sets */
  added?: Record<string, FeatureSetDeclaration>;

  /** Removed feature set names */
  removed?: string[];
}

// ============================================================================
// Section 7 — Scoped Access
// ============================================================================

/**
 * Scope configuration for a feature set — whitelist/blacklist patterns.
 * Pattern matching semantics (glob, regex, exact) are host-defined.
 */
export interface ScopeConfig {
  /** Patterns that are pre-approved */
  whitelist?: string[];

  /** Patterns that are always denied */
  blacklist?: string[];
}

/**
 * A scope label with optional payload, as used in scope/elevate and tools/call.
 * Spec Section 7.3.
 */
export interface ScopeLabel {
  /** Human-readable identifier for whitelist/blacklist matching */
  label: string;

  /** Arbitrary data passed back to server when approved */
  payload?: Record<string, unknown>;
}

/**
 * scope/elevate params (Server → Host, Request).
 * Spec Section 7.4.
 */
export interface ScopeElevateParams {
  /** Feature set requesting elevation */
  featureSet: string;

  /** The scope being requested */
  scope: ScopeLabel;
}

/**
 * scope/elevate result (Host → Server).
 * Spec Section 7.5.
 */
export interface ScopeElevateResult {
  /** Whether the scope was approved */
  approved: boolean;

  /** The payload from the request, returned on approval */
  payload?: Record<string, unknown>;

  /** Present if approved: false */
  reason?: string;
}

// ============================================================================
// Section 8 — State Management
// ============================================================================

/**
 * Checkpoint information returned in tool call responses.
 * Spec Section 8.2.
 */
export interface StateCheckpoint {
  /** Checkpoint identifier */
  checkpoint: string;

  /** Parent checkpoint (null for root) */
  parent: string | null;

  /**
   * Full state data (for host-managed state).
   * Mutually exclusive with `patch`.
   */
  data?: unknown;

  /**
   * JSON Patch (RFC 6902) delta from parent (for host-managed state).
   * Mutually exclusive with `data`.
   */
  patch?: JsonPatchOperation[];
}

/**
 * JSON Patch operation (RFC 6902).
 */
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

/**
 * state/rollback params (Host → Server, Request).
 * Spec Section 8.5.
 */
export interface StateRollbackParams {
  /** Feature set to rollback */
  featureSet: string;

  /** Checkpoint to rollback to */
  checkpoint: string;
}

/**
 * state/rollback result (Server → Host).
 * Spec Section 8.6.
 */
export interface StateRollbackResult {
  /** Checkpoint that was rolled back to */
  checkpoint: string;

  /** Whether rollback succeeded */
  success: boolean;

  /** Reason for failure (present if success: false) */
  reason?: string;
}

// ============================================================================
// Section 9 — Push Events
// ============================================================================

/**
 * push/event params (Server → Host, Request).
 * Spec Section 9.1.
 */
export interface PushEventParams {
  /** Declaring feature set */
  featureSet: string;

  /** Unique event identifier (for idempotency) */
  eventId: string;

  /** When the event occurred (ISO 8601) */
  timestamp: string;

  /** Provenance metadata (server-defined) */
  origin?: Record<string, unknown>;

  /** Event payload */
  payload: {
    /** Content for the model to interpret */
    content: McplContentBlock[];
  };
}

/**
 * push/event result (Host → Server).
 * Spec Section 9.3.
 */
export interface PushEventResult {
  /** Whether the event was accepted */
  accepted: boolean;

  /** Present if inference was triggered */
  inferenceId?: string;

  /** Present if accepted: false */
  reason?: string;
}

// ============================================================================
// Section 10 — Context Hooks
// ============================================================================

/**
 * Model information as provided in context hook calls.
 * Distinct from membrane's ModelInfo which tracks requested vs actual model.
 * Spec Section 10.1.
 */
export interface McplModelInfo {
  /** Model identifier (e.g., "claude-opus-4-5-20251101") */
  id: string;

  /** Model vendor (e.g., "anthropic") */
  vendor: string;

  /** Context window size in tokens */
  contextWindow: number;

  /** Model capabilities (e.g., ["vision", "tools"]) */
  capabilities: string[];
}

/**
 * context/beforeInference params (Host → Server, Request).
 * Spec Section 10.1.
 */
export interface BeforeInferenceParams {
  /** Unique identifier for this inference */
  inferenceId: string;

  /** Persistent across turns */
  conversationId: string;

  /** 0-indexed turn number */
  turnIndex: number;

  /** User input (null for continued generation) */
  userMessage: string | null;

  /** Current model metadata */
  model: McplModelInfo;

  /** Channel context (Section 14.4, optional) */
  channels?: ChannelContext;
}

/**
 * A context injection as returned by an MCPL server.
 * This is the wire format — it gets converted to context-manager's
 * ContextInjection (which uses membrane ContentBlock[]) by the host.
 * Spec Section 10.4.
 */
export interface McplContextInjection {
  /** Server-defined namespace */
  namespace: string;

  /** Where to inject */
  position: 'system' | 'beforeUser' | 'afterUser';

  /**
   * Content to inject.
   * May be a plain string (shorthand for a single text block) or content blocks.
   */
  content: string | McplContentBlock[];

  /** Arbitrary metadata (passed through) */
  metadata?: Record<string, unknown>;
}

/**
 * context/beforeInference result (Server → Host).
 * Spec Section 10.2.
 */
export interface BeforeInferenceResult {
  /** Feature set that provided this response */
  featureSet: string;

  /** Context injections to apply */
  contextInjections: McplContextInjection[];
}

/**
 * context/afterInference params (Host → Server, Request or Notification).
 * Spec Section 10.5.
 */
export interface AfterInferenceParams {
  /** Inference identifier (matches beforeInference) */
  inferenceId: string;

  /** Persistent across turns */
  conversationId: string;

  /** 0-indexed turn number */
  turnIndex: number;

  /** Original user input */
  userMessage: string | null;

  /** Generated assistant response */
  assistantMessage: string;

  /** Model metadata */
  model: McplModelInfo;

  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * context/afterInference result (Server → Host, only for blocking hooks).
 * Spec Section 10.5.
 */
export interface AfterInferenceResult {
  /** Feature set that provided this response */
  featureSet: string;

  /** Modified response text (replaces assistantMessage if present) */
  modifiedResponse?: string;

  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Section 11 — Server-Initiated Inference
// ============================================================================

/**
 * A message in an MCPL inference request.
 * Simpler than membrane's NormalizedMessage — just role + content string.
 */
export interface McplMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * inference/request params (Server → Host, Request).
 * Prefixed to avoid collision with API's InferenceRequestParams.
 * Spec Section 11.1.
 */
export interface McplInferenceRequestParams {
  /** Declaring feature set */
  featureSet: string;

  /** Associate with conversation (optional) */
  conversationId?: string;

  /** Stream response (default: false) */
  stream?: boolean;

  /** Messages for inference */
  messages: McplMessage[];

  /** Advisory preferences (host may ignore) */
  preferences?: McplInferencePreferences;
}

/**
 * Advisory preferences for server-initiated inference.
 * Spec Section 11.2.
 */
export interface McplInferencePreferences {
  /** Max output tokens */
  maxTokens?: number;

  /** Sampling temperature */
  temperature?: number;

  /**
   * Additional advisory keys (e.g., model, modelTier, costTier).
   * Host-defined and not guaranteed to be honored.
   */
  [key: string]: unknown;
}

/**
 * inference/request result (Host → Server).
 * Spec Section 11.3.
 */
export interface McplInferenceRequestResult {
  /** Generated content */
  content: string;

  /** Actual model used */
  model: string;

  /** Why generation stopped */
  finishReason: 'end_turn' | 'max_tokens' | 'stop_sequence';

  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * inference/chunk params (Host → Server, Notification).
 * Sent during streaming inference.
 * Spec Section 11.4.
 */
export interface InferenceChunkParams {
  /** ID of the original inference/request */
  requestId: string | number;

  /** Chunk index (0-based) */
  index: number;

  /** Text delta */
  delta: string;
}

// ============================================================================
// Section 12 — Model Information
// ============================================================================

// model/info has no params (empty object).
// The result reuses McplModelInfo.

// ============================================================================
// Section 14 — Channels
// ============================================================================

/**
 * Descriptor for a channel registered by an MCPL server.
 * Spec Section 14.2.
 */
export interface ChannelDescriptor {
  /** Unique within this connection (e.g., "discord:#general") */
  id: string;

  /** Platform/provider type (e.g., "discord", "telegram", "ui") */
  type: string;

  /** Human-readable label */
  label: string;

  /** Message direction */
  direction: 'outbound' | 'inbound' | 'bidirectional';

  /** Platform-specific address (e.g., { guild: "acme", channel: "#general" }) */
  address?: Record<string, unknown>;

  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Channel context included in beforeInference params.
 * Spec Section 14.4.
 */
export interface ChannelContext {
  /** Channel that triggered this inference */
  incoming?: {
    channelId: string;
    messageId: string;
    threadId?: string;
  };

  /** Default channel for outgoing messages */
  defaultOutgoing?: {
    channelId: string;
  };

  /** All candidate channels for this inference */
  candidates?: string[];
}

/**
 * channels/register params (Server → Host, Request).
 * Spec Section 14.3.
 */
export interface ChannelsRegisterParams {
  channels: ChannelDescriptor[];
}

/**
 * channels/register result (Host → Server).
 */
export interface ChannelsRegisterResult {
  registered: string[];
}

/**
 * channels/changed params (Server → Host, Notification).
 * Spec Section 14.3.
 */
export interface ChannelsChangedParams {
  added?: ChannelDescriptor[];
  removed?: string[];
  updated?: ChannelDescriptor[];
}

/**
 * channels/list result (Either direction, Request).
 * Spec Section 14.3.
 */
export interface ChannelsListResult {
  channels: ChannelDescriptor[];
}

/**
 * channels/open params (Host → Server, Request).
 * Spec Section 14.3.
 */
export interface ChannelsOpenParams {
  type: string;
  address?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * channels/open result (Server → Host).
 */
export interface ChannelsOpenResult {
  channel: ChannelDescriptor;
}

/**
 * channels/close params (Host → Server, Request).
 * Spec Section 14.3.
 */
export interface ChannelsCloseParams {
  channelId: string;
}

/**
 * channels/close result (Server → Host).
 */
export interface ChannelsCloseResult {
  closed: boolean;
}

/**
 * channels/outgoing/chunk params (Host → Server, Notification).
 * For observers receiving moderated deltas.
 * Spec Section 14.3.
 */
export interface ChannelsOutgoingChunkParams {
  inferenceId: string;
  conversationId: string;
  channelId: string;
  index: number;
  delta: string;
}

/**
 * channels/outgoing/complete params (Host → Server, Notification).
 * For observers receiving final moderated content.
 * Spec Section 14.3.
 */
export interface ChannelsOutgoingCompleteParams {
  inferenceId: string;
  conversationId: string;
  channelId: string;
  content: McplContentBlock[];
}

/**
 * channels/publish params (Host → Server, Notification or Request).
 * Asks connector server to deliver content to a channel.
 * Spec Section 14.3.
 */
export interface ChannelsPublishParams {
  conversationId: string;
  channelId: string;
  stream?: boolean;
  content: McplContentBlock[];
}

/**
 * channels/publish result (Server → Host, when sent as Request).
 */
export interface ChannelsPublishResult {
  delivered: boolean;
  messageId?: string;
}

/**
 * A single inbound message from a channel.
 * Used inside channels/incoming params.
 * Spec Section 14.3.
 */
export interface ChannelIncomingMessage {
  /** Channel this message came from */
  channelId: string;

  /** Unique message ID from the platform */
  messageId: string;

  /** Thread/conversation ID within the channel */
  threadId?: string;

  /** Message author */
  author: {
    id: string;
    name: string;
  };

  /** When the message was sent (ISO 8601) */
  timestamp: string;

  /** Message content */
  content: McplContentBlock[];

  /** Platform-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * channels/incoming params (Server → Host, Request).
 * Supports batching for busy channels.
 * Spec Section 14.3.
 */
export interface ChannelsIncomingParams {
  messages: ChannelIncomingMessage[];
}

/**
 * channels/incoming result (Host → Server).
 * Per-message results for partial acceptance.
 */
export interface ChannelsIncomingResult {
  results: ChannelIncomingMessageResult[];
}

/** Result for a single incoming message. */
export interface ChannelIncomingMessageResult {
  messageId: string;
  accepted: boolean;
  conversationId?: string;
}

// ============================================================================
// Section 11.5 — Inference Routing Policy (Host Configuration)
// ============================================================================

/**
 * Policy for routing server-initiated inference requests to models.
 * Non-normative; host-defined. See Spec Section 11.5.
 */
export interface InferenceRoutingPolicy {
  /** Default model for all inference requests */
  default: string;

  /** Model override per feature set name */
  byFeature?: Record<string, string>;

  /** Model override per pattern (e.g., "memory.*" → "claude-haiku-4-5") */
  wildcards?: Record<string, string>;

  /** Model override per conversation ID */
  overrides?: Record<string, string>;
}

// ============================================================================
// MCPL Method Names (string constants for routing)
// ============================================================================

/** All MCPL method names as defined in the spec. */
export const McplMethod = {
  // Push events (Server → Host)
  PushEvent: 'push/event',

  // Context hooks (Host → Server)
  BeforeInference: 'context/beforeInference',
  AfterInference: 'context/afterInference',

  // Server-initiated inference (Server → Host / Host → Server)
  InferenceRequest: 'inference/request',
  InferenceChunk: 'inference/chunk',

  // Model info (Server → Host)
  ModelInfo: 'model/info',

  // Feature sets
  FeatureSetsUpdate: 'featureSets/update',
  FeatureSetsChanged: 'featureSets/changed',

  // Scoped access (Server → Host)
  ScopeElevate: 'scope/elevate',

  // State management (Host → Server)
  StateRollback: 'state/rollback',

  // Channels
  ChannelsRegister: 'channels/register',
  ChannelsChanged: 'channels/changed',
  ChannelsList: 'channels/list',
  ChannelsOpen: 'channels/open',
  ChannelsClose: 'channels/close',
  ChannelsOutgoingChunk: 'channels/outgoing/chunk',
  ChannelsOutgoingComplete: 'channels/outgoing/complete',
  ChannelsPublish: 'channels/publish',
  ChannelsIncoming: 'channels/incoming',
  ChannelsTyping: 'channels/typing',
} as const;

export type McplMethodName = (typeof McplMethod)[keyof typeof McplMethod];

// ============================================================================
// MCP Standard Methods (not MCPL-specific, but needed for tool integration)
// ============================================================================

/**
 * Standard MCP tool definition as returned by `tools/list`.
 */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Standard MCP `tools/call` result.
 */
export interface McpToolCallResult {
  content: McpToolResultContent[];
  isError?: boolean;
  /** State checkpoint returned by stateful tools (Section 8.2). */
  state?: StateCheckpoint;
}

/**
 * A single content block in an MCP tool result.
 */
export interface McpToolResultContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}
