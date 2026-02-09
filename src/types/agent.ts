import type { ContentBlock } from 'membrane';
import type { ContextStrategy } from '@connectome/context-manager';
import type { ToolCallId, ToolResult, ToolCall } from './events.js';

/**
 * Configuration for an agent.
 */
export interface AgentConfig {
  /** Unique name for this agent */
  name: string;

  /** Model to use (e.g., 'claude-sonnet-4-20250514') */
  model: string;

  /** System prompt */
  systemPrompt: string;

  /** Context management strategy */
  strategy?: ContextStrategy;

  /**
   * Which tools this agent can use.
   * - 'all': all available tools
   * - string[]: specific tool names (with module prefix)
   */
  allowedTools?: 'all' | string[];

  /**
   * Which modules can trigger inference for this agent.
   * - 'all': any module
   * - string[]: specific module names
   */
  triggerSources?: 'all' | string[];

  /** Maximum tokens for response */
  maxTokens?: number;

  /** Temperature for inference */
  temperature?: number;
}

/**
 * Result of running inference.
 */
export interface InferenceResult {
  /** Tool calls to execute */
  toolCalls: ToolCall[];
  /** Speech content (text blocks) to send to handlers */
  speechContent: ContentBlock[];
  /** Raw request/response for logging */
  raw?: {
    request: unknown;
    response: unknown;
  };
  /** Usage stats */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Stop reason */
  stopReason?: string;
}

/**
 * Internal state of an agent.
 */
export type AgentState =
  | { status: 'idle' }
  | { status: 'inferring'; promise: Promise<InferenceResult> }
  | { status: 'waiting_for_tools'; pending: Map<ToolCallId, PendingToolCall>; completed: CompletedToolCall[] }
  | { status: 'ready'; toolResults: CompletedToolCall[] };

/**
 * A tool call that's in progress.
 */
export interface PendingToolCall {
  id: ToolCallId;
  name: string;
  input: unknown;
  startedAt: number;
}

/**
 * A tool call that has completed.
 */
export interface CompletedToolCall {
  id: ToolCallId;
  name: string;
  input: unknown;
  result: ToolResult;
  durationMs: number;
}

/**
 * Inference request for an agent.
 */
export interface InferenceRequest {
  agentName: string;
  reason: string;
  source: string;
  timestamp: number;
}
