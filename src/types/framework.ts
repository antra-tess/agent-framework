import type { JsStore } from 'chronicle';
import type { Membrane } from 'membrane';
import type { Module, EventResponse } from './module.js';
import type { AgentConfig, InferenceRequest } from './agent.js';
import type { QueueEvent } from './events.js';

/**
 * A module's response to an event, tagged with the module name.
 */
export interface ModuleEventResponse {
  moduleName: string;
  response: EventResponse;
}

/**
 * Configuration for the agent framework.
 */
export interface FrameworkConfig {
  /** Path to Chronicle store */
  storePath?: string;

  /** Or existing store (app-owned) */
  store?: JsStore;

  /** Membrane instance for LLM calls */
  membrane: Membrane;

  /** Agent configurations */
  agents: AgentConfig[];

  /** Modules to load */
  modules: Module[];

  /** Custom inference policy */
  inferencePolicy?: InferencePolicy;

  /** Custom error policy */
  errorPolicy?: ErrorPolicy;

  /** Interval for periodic store sync in milliseconds (default: 1000ms, 0 to disable) */
  syncIntervalMs?: number;
}

/**
 * Policy for deciding when to run inference.
 */
export interface InferencePolicy {
  /**
   * Decide whether to run inference for an agent.
   */
  shouldInfer(
    agentName: string,
    requests: InferenceRequest[],
    state: FrameworkState
  ): boolean;
}

/**
 * Policy for handling errors.
 */
export interface ErrorPolicy {
  /**
   * Handle an inference error.
   */
  onInferenceError(
    error: Error,
    agentName: string,
    attempt: number
  ): ErrorAction;

  /** Maximum retry attempts */
  maxRetries: number;
}

/**
 * Action to take after an error.
 */
export type ErrorAction =
  | { retry: true; delayMs: number }
  | { retry: false; emit?: QueueEvent };

/**
 * Framework state exposed to policies.
 */
export interface FrameworkState {
  /** Get agent status */
  getAgentStatus(name: string): import('./agent.js').AgentState | null;

  /** Get module by name */
  getModule(name: string): Module | null;

  /** Get all pending inference requests */
  getPendingRequests(): InferenceRequest[];

  /** Current queue depth */
  queueDepth: number;
}

/**
 * Events emitted by the framework for observability.
 */
export type FrameworkEvent =
  | { type: 'message:added'; messageId: string; source: string }
  | { type: 'inference:start'; agentName: string }
  | { type: 'inference:complete'; agentName: string; durationMs: number }
  | { type: 'inference:error'; agentName: string; error: Error }
  | { type: 'tool:start'; moduleName: string; toolName: string; callId: string }
  | { type: 'tool:complete'; moduleName: string; toolName: string; callId: string; durationMs: number }
  | { type: 'tool:error'; moduleName: string; toolName: string; callId: string; error: Error }
  | { type: 'module:start'; moduleName: string }
  | { type: 'module:stop'; moduleName: string }
  | { type: 'queue:event'; event: QueueEvent }
  | { type: 'event:handled'; event: QueueEvent; responses: ModuleEventResponse[] };

/**
 * Listener for framework events.
 */
export type FrameworkEventListener = (event: FrameworkEvent) => void;

/**
 * Entry in the inference log.
 */
export interface InferenceLogEntry {
  timestamp: number;
  agentName: string;
  requestId: string;
  /** Whether inference succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Request data or blob ID if large */
  request: unknown | { blobId: string };
  /** Response data or blob ID if large (only if successful) */
  response?: unknown | { blobId: string };
  durationMs: number;
  tokenUsage?: {
    input: number;
    output: number;
  };
  /** Stop reason from the model */
  stopReason?: string;
}

/**
 * Entry in the event log - records a processed event with all module responses.
 */
export interface EventLogEntry {
  timestamp: number;
  /** The event that was processed */
  event: QueueEvent;
  /** Responses from all modules, or blob ID if large */
  responses: ModuleEventResponse[] | { blobId: string };
}

/**
 * Query options for event logs.
 */
export interface EventLogQuery {
  /** Filter by event type */
  eventType?: string;
  /** Filter by module name (modules that responded) */
  moduleName?: string;
  /** Max number of logs to return */
  limit?: number;
  /** Skip first N logs (for pagination) */
  offset?: number;
  /** Search pattern for content (regex) */
  pattern?: string;
}

/**
 * Result from querying event logs.
 */
export interface EventLogQueryResult {
  entries: EventLogEntryWithId[];
  total: number;
  hasMore: boolean;
}

/**
 * Event log entry with Chronicle sequence ID.
 */
export interface EventLogEntryWithId {
  sequence: number;
  entry: EventLogEntry;
  /** Summary for display without resolving blobs */
  summary?: EventLogSummary;
}

/**
 * Summary view of an event log (without full responses).
 */
export interface EventLogSummary {
  timestamp: number;
  eventType: string;
  moduleCount: number;
  /** Modules that requested inference */
  modulesRequestingInference: string[];
  /** Modules that added messages */
  modulesAddingMessages: string[];
  /** Whether responses are stored as blob */
  responsesIsBlob: boolean;
}
