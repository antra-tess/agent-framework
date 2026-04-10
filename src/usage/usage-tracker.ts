import type { SessionUsage, SessionUsageSnapshot } from './types.js';

export class UsageTracker {
  private totals: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  private byAgent: Map<string, { usage: SessionUsage; inferenceCount: number }> = new Map();
  private inferenceCount = 0;
  private emitTrace: (event: { type: string; [key: string]: unknown }) => void;

  constructor(opts: {
    emitTrace: (event: { type: string; [key: string]: unknown }) => void;
  }) {
    this.emitTrace = opts.emitTrace;
  }

  onInferenceCompleted(agentName: string, usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }, estimatedCost?: { total: number; currency: string }): void {
    const cacheCreation = usage.cacheCreationTokens ?? 0;
    const cacheRead = usage.cacheReadTokens ?? 0;

    this.totals.inputTokens += usage.inputTokens;
    this.totals.outputTokens += usage.outputTokens;
    this.totals.cacheCreationTokens += cacheCreation;
    this.totals.cacheReadTokens += cacheRead;
    if (estimatedCost) {
      if (!this.totals.estimatedCost) {
        this.totals.estimatedCost = { total: 0, currency: estimatedCost.currency };
      }
      this.totals.estimatedCost.total += estimatedCost.total;
    }
    this.inferenceCount++;

    let agent = this.byAgent.get(agentName);
    if (!agent) {
      agent = { usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, inferenceCount: 0 };
      this.byAgent.set(agentName, agent);
    }
    agent.usage.inputTokens += usage.inputTokens;
    agent.usage.outputTokens += usage.outputTokens;
    agent.usage.cacheCreationTokens += cacheCreation;
    agent.usage.cacheReadTokens += cacheRead;
    if (estimatedCost) {
      if (!agent.usage.estimatedCost) {
        agent.usage.estimatedCost = { total: 0, currency: estimatedCost.currency };
      }
      agent.usage.estimatedCost.total += estimatedCost.total;
    }
    agent.inferenceCount++;

    this.emitTrace({
      type: 'usage:updated',
      totals: { ...this.totals },
      agentName,
      inferenceCount: this.inferenceCount,
    });
  }

  getSnapshot(): SessionUsageSnapshot {
    return {
      totals: { ...this.totals },
      byAgent: [...this.byAgent.entries()].map(([name, data]) => ({
        agentName: name,
        usage: { ...data.usage },
        inferenceCount: data.inferenceCount,
      })),
      inferenceCount: this.inferenceCount,
    };
  }
}
