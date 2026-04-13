export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCost?: { total: number; currency: string };
}

export interface AgentUsage {
  agentName: string;
  usage: SessionUsage;
  inferenceCount: number;
}

export interface SessionUsageSnapshot {
  totals: SessionUsage;
  byAgent: AgentUsage[];
  inferenceCount: number;
}

/** Trace event emitted by UsageTracker after each inference completion. */
export interface UsageUpdatedEvent {
  type: 'usage:updated';
  totals: SessionUsage;
  agentName: string;
  inferenceCount: number;
}
