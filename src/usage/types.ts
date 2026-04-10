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
