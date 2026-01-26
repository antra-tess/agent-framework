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
      tokenUsage?: { input: number; output: number };
    })
  | (TraceEventBase & {
      type: 'inference:failed';
      agentName: string;
      error: string;
      stack?: string;
    })

  // Tool lifecycle
  | (TraceEventBase & {
      type: 'tool:started';
      module: string;
      tool: string;
      callId: string;
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

  // Module lifecycle
  | (TraceEventBase & { type: 'module:added'; moduleName: string })
  | (TraceEventBase & { type: 'module:removed'; moduleName: string })

  // Message lifecycle
  | (TraceEventBase & {
      type: 'message:added';
      messageId: string;
      source: string;
    });

/**
 * Listener for trace events.
 */
export type TraceEventListener = (event: TraceEvent) => void;
