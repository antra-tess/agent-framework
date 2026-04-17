import type { SessionUsage, SessionUsageSnapshot, UsageUpdatedEvent } from './types.js';

function snapshotUsage(usage: SessionUsage): SessionUsage {
  return {
    ...usage,
    estimatedCost: usage.estimatedCost ? { ...usage.estimatedCost } : undefined,
  };
}

function accumulateUsage(
  target: SessionUsage,
  tokens: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number },
  estimatedCost?: { total: number; currency: string }
): void {
  target.inputTokens += tokens.inputTokens;
  target.outputTokens += tokens.outputTokens;
  target.cacheCreationTokens += tokens.cacheCreationTokens;
  target.cacheReadTokens += tokens.cacheReadTokens;
  if (estimatedCost) {
    if (!target.estimatedCost) {
      target.estimatedCost = { total: 0, currency: estimatedCost.currency };
    } else if (target.estimatedCost.currency !== estimatedCost.currency) {
      // Mixed currencies — drop cost tracking rather than produce garbage
      target.estimatedCost = undefined;
      return;
    }
    target.estimatedCost.total += estimatedCost.total;
  }
}

function parseUsage(raw: unknown): SessionUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.inputTokens !== 'number' || typeof o.outputTokens !== 'number') return null;
  return {
    inputTokens: o.inputTokens,
    outputTokens: o.outputTokens as number,
    cacheCreationTokens: typeof o.cacheCreationTokens === 'number' ? o.cacheCreationTokens : 0,
    cacheReadTokens: typeof o.cacheReadTokens === 'number' ? o.cacheReadTokens : 0,
    estimatedCost: o.estimatedCost && typeof o.estimatedCost === 'object'
      ? { total: (o.estimatedCost as any).total, currency: (o.estimatedCost as any).currency }
      : undefined,
  };
}

export interface PersistedUsageState {
  totals: SessionUsage;
  byAgent: Array<{ agentName: string; usage: SessionUsage; inferenceCount: number }>;
  inferenceCount: number;
}

export class UsageTracker {
  private totals: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  private byAgent: Map<string, { usage: SessionUsage; inferenceCount: number }> = new Map();
  private inferenceCount = 0;
  private emitTrace: (event: UsageUpdatedEvent) => void;

  constructor(opts: {
    emitTrace: (event: UsageUpdatedEvent) => void;
    restored?: PersistedUsageState;
  }) {
    this.emitTrace = opts.emitTrace;
    if (opts.restored) {
      this.restoreFrom(opts.restored);
    }
  }

  private restoreFrom(state: PersistedUsageState): void {
    const totals = parseUsage(state.totals);
    if (!totals) return;
    this.totals = totals;
    this.inferenceCount = typeof state.inferenceCount === 'number' ? state.inferenceCount : 0;
    if (Array.isArray(state.byAgent)) {
      for (const entry of state.byAgent) {
        const usage = parseUsage(entry.usage);
        if (usage && typeof entry.agentName === 'string') {
          this.byAgent.set(entry.agentName, {
            usage,
            inferenceCount: typeof entry.inferenceCount === 'number' ? entry.inferenceCount : 0,
          });
        }
      }
    }
  }

  toJSON(): PersistedUsageState {
    return {
      totals: snapshotUsage(this.totals),
      byAgent: [...this.byAgent.entries()].map(([name, data]) => ({
        agentName: name,
        usage: snapshotUsage(data.usage),
        inferenceCount: data.inferenceCount,
      })),
      inferenceCount: this.inferenceCount,
    };
  }

  onInferenceCompleted(agentName: string, usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }, estimatedCost?: { total: number; currency: string }): void {
    const tokens = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
    };

    accumulateUsage(this.totals, tokens, estimatedCost);
    this.inferenceCount++;

    let agent = this.byAgent.get(agentName);
    if (!agent) {
      agent = { usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, inferenceCount: 0 };
      this.byAgent.set(agentName, agent);
    }
    accumulateUsage(agent.usage, tokens, estimatedCost);
    agent.inferenceCount++;

    this.emitTrace({
      type: 'usage:updated',
      totals: snapshotUsage(this.totals),
      agentName,
      inferenceCount: this.inferenceCount,
    });
  }

  getSnapshot(): SessionUsageSnapshot {
    return {
      totals: snapshotUsage(this.totals),
      byAgent: [...this.byAgent.entries()].map(([name, data]) => ({
        agentName: name,
        usage: snapshotUsage(data.usage),
        inferenceCount: data.inferenceCount,
      })),
      inferenceCount: this.inferenceCount,
    };
  }
}
