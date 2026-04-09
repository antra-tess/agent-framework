export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface AgentUsage {
  agentName: string;
  usage: SessionUsage;
  inferenceCount: number;
}

export interface SessionBillingSnapshot {
  totals: SessionUsage;
  byAgent: AgentUsage[];
  inferenceCount: number;
}
