import type { ProcessEvent } from './events.js';
import type { ModuleProcessResponse } from './framework.js';

/**
 * Base for all trace events.
 * TraceEvents are observability-only — they NEVER drive logic.
 */
export interface TraceEventBase {
  /** When this trace was emitted */
  timestamp: number;
  /** Optional correlation ID for distributed tracing */
  traceId?: string;
}

/**
 * Observability events emitted by the framework.
 * Subscribe via framework.onTrace() to monitor system behavior.
 *
 * These are purely informational — use them for:
 * - UI updates (showing inference progress, tool execution)
 * - Logging and debugging
 * - Metrics and monitoring
 * - Broadcasting to WebSocket clients
 *
 * They should NEVER be used to drive application logic.
 * For that, use ProcessEvent via the event queue.
 */
export type TraceEvent =
  // Process lifecycle
  | (TraceEventBase & { type: 'process:received'; processEvent: ProcessEvent })
  | (TraceEventBase & {
      type: 'process:completed';
      processEvent: ProcessEvent;
      responses: ModuleProcessResponse[];
      durationMs: number;
    })

  // Inference lifecycle
  | (TraceEventBase & { type: 'inference:started'; agentName: string })
  | (TraceEventBase & {
      type: 'inference:completed';
      agentName: string;
      durationMs: number;
      tokenUsage?: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
    })
  | (TraceEventBase & {
      type: 'inference:aborted';
      agentName: string;
      durationMs: number;
      reason?: string;
    })
  | (TraceEventBase & {
      type: 'inference:failed';
      agentName: string;
      error: string;
      stack?: string;
    })
  | (TraceEventBase & {
      type: 'inference:exhausted';
      agentName: string;
      error: string;
    })

  // Streaming inference lifecycle
  | (TraceEventBase & {
      type: 'inference:tokens';
      agentName: string;
      content: string;
    })
  | (TraceEventBase & {
      type: 'inference:tool_calls_yielded';
      agentName: string;
      calls: Array<{ id: string; name: string; input?: unknown }>;
    })
  | (TraceEventBase & {
      type: 'inference:usage';
      agentName: string;
      tokenUsage: { input: number; output: number };
    })
  | (TraceEventBase & {
      type: 'inference:stream_resumed';
      agentName: string;
    })
  | (TraceEventBase & {
      type: 'inference:stream_restarted';
      agentName: string;
      reason: string;
      inputTokens: number;
      budget: number;
    })
  | (TraceEventBase & {
      type: 'inference:turn_ended';
      agentName: string;
    })

  // Tool lifecycle
  | (TraceEventBase & {
      type: 'tool:started';
      module: string;
      tool: string;
      callId: string;
      input?: unknown;
    })
  | (TraceEventBase & {
      type: 'tool:completed';
      module: string;
      tool: string;
      callId: string;
      durationMs: number;
    })
  | (TraceEventBase & {
      type: 'tool:failed';
      module: string;
      tool: string;
      callId: string;
      error: string;
      stack?: string;
    })
  | (TraceEventBase & {
      type: 'tool:result_dropped';
      agentName: string;
      callId: string;
      agentStatus: string;
      result: unknown;
    })

  // Module lifecycle
  | (TraceEventBase & { type: 'module:added'; moduleName: string })
  | (TraceEventBase & { type: 'module:removed'; moduleName: string })

  // Inference request health
  | (TraceEventBase & {
      type: 'inference:request_dropped';
      agentName: string;
      reason: string;
      requestCount: number;
      oldestRequestAge: number;
    })
  | (TraceEventBase & {
      type: 'inference:request_stale';
      agentName: string;
      agentStatus: string;
      requestCount: number;
      oldestRequestAge: number;
    })

  // Message lifecycle
  | (TraceEventBase & {
      type: 'message:added';
      messageId: string;
      source: string;
    })

  // Undo/redo lifecycle
  | (TraceEventBase & {
      type: 'undo:completed';
      agentName: string;
      turnIndex: number;
      fromBranch: string;
      toBranch: string;
    })
  | (TraceEventBase & {
      type: 'redo:completed';
      agentName: string;
      fromBranch: string;
      toBranch: string;
    });

/**
 * Listener for trace events.
 */
export type TraceEventListener = (event: TraceEvent) => void;
