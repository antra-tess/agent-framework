import type { ContentBlock, ToolDefinition as MembraneToolDefinition } from '@animalabs/membrane';
import type { MessageId } from '@animalabs/context-manager';

/**
 * Unique identifier for a tool call.
 */
export type ToolCallId = string;

/**
 * Re-export membrane's ToolDefinition for modules to use.
 */
export type ToolDefinition = MembraneToolDefinition;

/**
 * Events that flow through the framework's processing queue.
 *
 * ProcessEvents represent work to be done — modules respond to them via onProcess().
 * They are distinct from TraceEvents, which are observability-only notifications.
 *
 * Modules can define their own namespaced events (e.g., 'api:message', 'discord:reaction').
 */
export type ProcessEvent =
  | ExternalMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | TimerFiredEvent
  | InferenceRequestEvent
  | MessageEditedEvent
  | MessageRemovedEvent
  | ModuleEvent
  | ApiMessageEvent
  | ApiInferenceRequestEvent
  | McplPushEvent
  | McplChannelIncomingEvent
  | CustomEvent;

/**
 * API message event - from the API server.
 */
export interface ApiMessageEvent {
  type: 'api:message';
  participant: string;
  content: string;
  metadata?: Record<string, unknown>;
  triggerInference?: boolean;
  targetAgents?: string[];
}

/**
 * API inference request - from the API server.
 */
export interface ApiInferenceRequestEvent {
  type: 'api:inference-request';
  agentName?: string;
  reason?: string;
}

/**
 * Generic custom event for module-specific namespaced events.
 * Use this for events like 'discord:message', 'slack:reaction', etc.
 */
export interface CustomEvent {
  type: `${string}:${string}`;
  [key: string]: unknown;
}

/**
 * Message from an external source (Discord, HTTP, CLI, etc.)
 */
export interface ExternalMessageEvent {
  type: 'external-message';
  /** Module that produced this event */
  source: string;
  /** Raw content from external system */
  content: unknown;
  /** External system metadata */
  metadata: Record<string, unknown>;
  /** Whether this should trigger inference */
  triggerInference?: boolean;
  /** Specific agents to trigger (if not all) */
  targetAgents?: string[];
}

/**
 * Result of a tool call.
 */
export interface ToolResultEvent {
  type: 'tool-result';
  /** ID of the original tool call */
  callId: ToolCallId;
  /** Agent that made the call */
  agentName: string;
  /** Module that handled the call */
  moduleName: string;
  /** Result of the tool call */
  result: ToolResult;
}

/**
 * Tool call scheduled for execution.
 */
export interface ToolCallEvent {
  type: 'tool-call';
  /** ID of the tool call */
  callId: ToolCallId;
  /** Agent that made the call */
  agentName: string;
  /** Module that will handle the call */
  moduleName: string;
  /** Un-prefixed tool name */
  toolName: string;
  /** Full tool call payload */
  call: ToolCall;
}

/**
 * Scheduled timer fired.
 */
export interface TimerFiredEvent {
  type: 'timer-fired';
  /** Timer identifier */
  timerId: string;
  /** Reason for the timer */
  reason: string;
  /** Specific agent to wake (if any) */
  agentName?: string;
}

/**
 * Explicit request to run inference.
 */
export interface InferenceRequestEvent {
  type: 'inference-request';
  /** Agent to run inference for */
  agentName: string;
  /** Reason for the request */
  reason: string;
  /** Module that requested it */
  source: string;
}

/**
 * External message was edited.
 */
export interface MessageEditedEvent {
  type: 'message-edited';
  /** Module that produced this event */
  source: string;
  /** Our internal message ID */
  messageId: MessageId;
  /** New content */
  newContent: ContentBlock[];
}

/**
 * External message was removed.
 */
export interface MessageRemovedEvent {
  type: 'message-removed';
  /** Module that produced this event */
  source: string;
  /** Our internal message ID */
  messageId: MessageId;
}

/**
 * Generic module-specific event.
 */
export interface ModuleEvent {
  type: 'module-event';
  /** Module that produced this event */
  source: string;
  /** Module-specific event type */
  eventType: string;
  /** Module-specific payload */
  payload: unknown;
}

/**
 * Result of a tool execution.
 */
export interface ToolResult {
  /** Whether the tool succeeded */
  success: boolean;
  /** Result data (if success) */
  data?: unknown;
  /** Error message (if failure) */
  error?: string;
  /** Whether this was an error (for LLM) */
  isError?: boolean;
  /**
   * When true, the framework saves tool_use + tool_result messages to context,
   * cancels the active stream, and resets the agent to idle.
   * This is a "sleep until next event" primitive — the LLM expects the call to block.
   * Adapted from Anarchid/agent-framework@mcpl-module-proto.
   */
  endTurn?: boolean;
}

/**
 * A tool call from the LLM.
 */
export interface ToolCall {
  /** Unique ID for this call */
  id: ToolCallId;
  /** Full tool name (module:tool) */
  name: string;
  /** Tool input */
  input: unknown;
  /** The agent that made this tool call. Set by the framework dispatch layer. */
  callerAgentName?: string;
}

// ============================================================================
// MCPL Events (Steps 6-7)
// ============================================================================

/**
 * Push event from an MCPL server (Section 9).
 * Converted from wire-format McplContentBlock to membrane ContentBlock.
 */
export interface McplPushEvent {
  type: 'mcpl:push-event';
  serverId: string;
  featureSet: string;
  eventId: string;
  content: ContentBlock[];
  origin?: Record<string, unknown>;
  timestamp: string;
  inferenceId: string;
  triggerInference?: boolean;
  targetAgents?: string[];
}

/**
 * Incoming channel message from an MCPL server (Section 14).
 * Converted from wire-format McplContentBlock to membrane ContentBlock.
 */
export interface McplChannelIncomingEvent {
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

