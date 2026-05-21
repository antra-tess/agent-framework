/**
 * HealthModule — minimal framework self-introspection.
 *
 * Exposes a single tool, `health--snapshot`, that returns a structured
 * snapshot of recent framework activity. Useful when an agent gets a
 * concurrency timeout, a 400 from the API, or wants to verify it's not
 * silently failing.
 *
 * Sources:
 *  - `framework/inference-log` (queryInferenceLogs) — recent inference
 *    success/error counts, last N errors, per-agent token totals.
 *  - `modules/subagent/state` — best-effort. The slot is owned by
 *    `connectome-host`'s SubagentModule, not by this module. We read it
 *    directly from the chronicle store so the tool works even when the
 *    HealthModule has no awareness of SubagentModule's internals.
 *  - Registered module names.
 *
 * Kept deliberately read-only: no side effects, no kill switches.
 * Reaping/cancellation lives in the SubagentModule.
 */

import type { JsStore } from '@animalabs/chronicle';
import type { Module, ModuleContext } from '../../types/module.js';
import type { ToolDefinition, ToolCall, ToolResult, ProcessEvent } from '../../types/events.js';
import type { EventResponse, ProcessState } from '../../types/module.js';
import type { AgentFramework } from '../../framework.js';

export interface HealthModuleConfig {
  /**
   * Default number of recent inferences to summarize when the tool is
   * called without an explicit limit. Default: 20.
   */
  defaultLookback?: number;

  /**
   * State slot to read for the subagent registry. Allows hosts that name
   * their subagent module differently to point this at the right slot.
   * Default: `modules/subagent/state`.
   */
  subagentStateId?: string;
}

interface SnapshotInput {
  /** How many recent inferences to summarize. Default config.defaultLookback. */
  lookback?: number;
  /** Include per-agent token totals across all-time. Default true. */
  includeTokens?: boolean;
  /** Include subagent registry summary. Default true. */
  includeSubagents?: boolean;
}

interface PersistedSubagentRecord {
  name: string;
  type?: string;
  status?: string;
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  toolCallsCount?: number;
  statusMessage?: string;
}

export class HealthModule implements Module {
  readonly name = 'health';

  private ctx: ModuleContext | null = null;
  private framework: AgentFramework | null = null;
  private store: JsStore | null = null;
  private config: Required<HealthModuleConfig>;

  constructor(config: HealthModuleConfig = {}) {
    this.config = {
      defaultLookback: config.defaultLookback ?? 20,
      subagentStateId: config.subagentStateId ?? 'modules/subagent/state',
    };
  }

  /**
   * Wire framework + store. Host calls this after AgentFramework.create()
   * so the module can query inference logs and chronicle state.
   */
  bind(framework: AgentFramework, store: JsStore): void {
    this.framework = framework;
    this.store = store;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'snapshot',
        description:
          'Return a structured snapshot of framework health: recent inference success/error counts, last errors, per-agent token totals, active subagent registry, and registered modules. Read-only. Useful when diagnosing why a spawn timed out, why an inference failed, or whether the framework is silently degraded.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            lookback: {
              type: 'number',
              description: `How many recent inferences to summarize (default ${this.config.defaultLookback}).`,
            },
            includeTokens: {
              type: 'boolean',
              description: 'Include per-agent token totals (default true).',
            },
            includeSubagents: {
              type: 'boolean',
              description: 'Include subagent registry summary (default true).',
            },
          },
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name !== 'snapshot') {
      return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
    }
    const input = (call.input ?? {}) as SnapshotInput;
    const lookback = input.lookback ?? this.config.defaultLookback;
    const includeTokens = input.includeTokens ?? true;
    const includeSubagents = input.includeSubagents ?? true;

    try {
      const snapshot = this.buildSnapshot(lookback, includeTokens, includeSubagents);
      return { success: true, data: snapshot };
    } catch (error) {
      return {
        success: false,
        isError: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  private buildSnapshot(
    lookback: number,
    includeTokens: boolean,
    includeSubagents: boolean,
  ): Record<string, unknown> {
    if (!this.framework || !this.store) {
      throw new Error(
        'HealthModule not bound — host must call bind(framework, store) before tool dispatch.',
      );
    }

    // ── Inference log summary ───────────────────────────────────────────
    // queryInferenceLogs returns InferenceLogEntryWithId. Prefer the
    // `summary` field (no blob deref) but fall back to `entry` for older
    // records or if the summarizer wasn't populated.
    const recent = this.framework.queryInferenceLogs({ limit: lookback });
    const recentEntries = recent.entries ?? [];

    const projectSummary = (e: typeof recentEntries[number]) => {
      const s = e.summary ?? e.entry;
      return {
        timestamp: s.timestamp,
        agentName: s.agentName,
        success: s.success,
        error: s.error,
        requestId: s.requestId,
        tokenUsage: s.tokenUsage,
      };
    };

    const recentErrors = recentEntries
      .map(projectSummary)
      .filter((s) => s.success === false)
      .slice(0, 10)
      .map((s) => ({
        timestamp: s.timestamp,
        agentName: s.agentName,
        error: typeof s.error === 'string' ? s.error.slice(0, 400) : s.error,
        requestId: s.requestId,
      }));

    let tokenTotals: Record<string, { input: number; output: number; cacheRead: number; inferences: number }> | undefined;
    if (includeTokens) {
      // Pull a larger window for totals — defaults to 1000 entries which is
      // enough to characterize ongoing usage without dragging the entire log.
      const wide = this.framework.queryInferenceLogs({ limit: 1000 });
      tokenTotals = {};
      for (const raw of wide.entries ?? []) {
        const s = projectSummary(raw);
        const agent = s.agentName ?? 'unknown';
        const t = tokenTotals[agent] ?? { input: 0, output: 0, cacheRead: 0, inferences: 0 };
        t.inferences++;
        const u = s.tokenUsage;
        if (u) {
          t.input += u.input ?? 0;
          t.output += u.output ?? 0;
          t.cacheRead += u.cacheRead ?? 0;
        }
        tokenTotals[agent] = t;
      }
    }

    // ── Subagent registry summary (best-effort) ────────────────────────
    let subagents: Array<Record<string, unknown>> | string | undefined;
    if (includeSubagents) {
      try {
        const raw = this.store.getStateJson(this.config.subagentStateId);
        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const agents = (parsed as { agents?: Record<string, PersistedSubagentRecord> })?.agents
            ?? {};
          const now = Date.now();
          subagents = Object.entries(agents).map(([key, sa]) => {
            const startedAt = sa.startedAt ?? 0;
            const lastActivityAt = sa.lastActivityAt ?? startedAt;
            return {
              key,
              name: sa.name,
              type: sa.type,
              status: sa.status,
              startedAt: startedAt > 0 ? new Date(startedAt).toISOString() : null,
              lastActivityAt: lastActivityAt > 0 ? new Date(lastActivityAt).toISOString() : null,
              runtimeSeconds: startedAt > 0 ? Math.floor((now - startedAt) / 1000) : null,
              silentSeconds: lastActivityAt > 0 ? Math.floor((now - lastActivityAt) / 1000) : null,
              toolCallsCount: sa.toolCallsCount,
              statusMessage: sa.statusMessage,
            };
          });
        } else {
          subagents = 'no subagent state registered';
        }
      } catch (error) {
        subagents = `error reading subagent state: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    // ── Module list ────────────────────────────────────────────────────
    const modules = this.ctx ? this.listModulesViaContext() : [];

    return {
      timestamp: new Date().toISOString(),
      window: {
        lookback,
        inferencesInWindow: recentEntries.length,
      },
      inferences: {
        successCount: recentEntries.filter((e) => projectSummary(e).success).length,
        errorCount: recentEntries.filter((e) => projectSummary(e).success === false).length,
        recentErrors,
      },
      tokenTotalsByAgent: tokenTotals,
      subagents,
      modules,
    };
  }

  private listModulesViaContext(): string[] {
    // ModuleContext.getActiveTools returns flat tool names; derive module set
    // from the prefix before '--'. This avoids needing a dedicated module-list
    // accessor on ModuleContext (kept narrow on purpose).
    const tools = this.ctx?.getActiveTools() ?? [];
    const set = new Set<string>();
    for (const t of tools) {
      const i = t.name.indexOf('--');
      if (i > 0) set.add(t.name.slice(0, i));
    }
    return [...set].sort();
  }
}
