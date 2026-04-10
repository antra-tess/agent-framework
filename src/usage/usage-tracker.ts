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

export class UsageTracker {
  private totals: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  private byAgent: Map<string, { usage: SessionUsage; inferenceCount: number }> = new Map();
  private inferenceCount = 0;
  private emitTrace: (event: UsageUpdatedEvent) => void;

  constructor(opts: {
    emitTrace: (event: UsageUpdatedEvent) => void;
  }) {
    this.emitTrace = opts.emitTrace;
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
