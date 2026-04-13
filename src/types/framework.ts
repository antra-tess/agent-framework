import type { JsStore } from '@animalabs/chronicle';
import type { Membrane } from '@animalabs/membrane';
import type { Module, EventResponse } from './module.js';
import type { AgentConfig, InferenceRequest } from './agent.js';
import type { ProcessEvent } from './events.js';
import type { McplServerConfig, InferenceRoutingPolicy } from '../mcpl/types.js';
import type { GateOptions } from '../gate/types.js';

// Re-export trace types
export type { TraceEvent, TraceEventListener } from './trace.js';

/**
 * A module's response to a process event, tagged with the module name.
 */
export interface ModuleProcessResponse {
  moduleName: string;
  response: EventResponse;
}

/**
 * Configuration for process event logging.
 */
export interface ProcessLoggingConfig {
  /** Persist process logs to Chronicle (default: false) */
  persist?: boolean;
  /** Broadcast process:completed trace events (default: false) */
  broadcast?: boolean;
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

  /** Process logging configuration (default: disabled) */
  processLogging?: ProcessLoggingConfig;

  /** MCPL server configurations. If omitted or empty, no MCPL subsystems are created. */
  mcplServers?: McplServerConfig[];

  /** Inference routing policy for server-initiated inference (optional). */
  inferenceRouting?: InferenceRoutingPolicy;

  /** EventGate config. If omitted, all events trigger inference (unchanged default). */
  gate?: GateOptions;
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
  | { retry: false; emit?: ProcessEvent };

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
    cacheCreation?: number;
    cacheRead?: number;
  };
  /** Stop reason from the model */
  stopReason?: string;
}

/**
 * Entry in the process log - records a processed event with all module responses.
 */
export interface ProcessLogEntry {
  timestamp: number;
  /** The process event that was handled */
  processEvent: ProcessEvent;
  /** Responses from all modules, or blob ID if large */
  responses: ModuleProcessResponse[] | { blobId: string };
}

/**
 * Query options for process logs.
 */
export interface ProcessLogQuery {
  /** Filter by process event type */
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
 * Result from querying process logs.
 */
export interface ProcessLogQueryResult {
  entries: ProcessLogEntryWithId[];
  total: number;
  hasMore: boolean;
}

/**
 * Process log entry with Chronicle sequence ID.
 */
export interface ProcessLogEntryWithId {
  sequence: number;
  entry: ProcessLogEntry;
  /** Summary for display without resolving blobs */
  summary?: ProcessLogSummary;
}

/**
 * Summary view of a process log (without full responses).
 */
export interface ProcessLogSummary {
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
