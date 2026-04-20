/**
 * EventGate — file-driven inference gating with per-policy debounce.
 *
 * Reads policies from a `gate.json` config file. Policies are evaluated in
 * order — first match wins. Each policy specifies a behavior: "always"
 * (trigger immediately), "skip" (don't trigger), or { debounce: ms }
 * (batch events per-policy, deliver when timer fires).
 *
 * The gate controls inference triggering only. Events always enter context
 * and are always dispatched to modules — the gate decides whether to spend
 * inference tokens, not whether the agent should know about the event.
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ToolDefinition } from '../types/events.js';
import type {
  GateConfig,
  GatePolicy,
  GatePolicyMatch,
  GateBehavior,
  GateDecision,
  GateEventInfo,
  GatePolicyStats,
  GateStatus,
} from './types.js';

// Re-export types consumers need
export type { GateConfig, GateOptions, GateDecision, GateEventInfo } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max content length stored in pending debounce events. */
const MAX_CONTENT_SNIPPET = 200;
/** Max content length shown in onWake trace summaries. */
const MAX_TRACE_SNIPPET = 80;
/** Max events buffered during inference before oldest are dropped. */
const MAX_INFERENCE_BUFFER = 100;
/** Minimum interval between filesystem checks for config changes (ms). */
const RELOAD_THROTTLE_MS = 1000;
/** Minimum debounce value (ms). */
const MIN_DEBOUNCE_MS = 100;
/** Maximum debounce value (ms). */
const MAX_DEBOUNCE_MS = 300_000;

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: GateConfig = {
  policies: [],
  default: 'always',
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingEvent {
  policyName: string;
  content: string;
  eventType: string;
  timestamp: number;
}

interface DebounceState {
  timer: ReturnType<typeof setTimeout>;
  events: PendingEvent[];
}

interface CompiledPolicy {
  policy: GatePolicy;
  filterRegex?: RegExp;
  sourceRegex?: RegExp;
  channelRegex?: RegExp;
  mountRegex?: RegExp;
  pathRegex?: RegExp;
}

interface PolicyStats {
  matchCount: number;
  lastMatchTimestamp: number | null;
}

// ---------------------------------------------------------------------------
// Trace event shape (subset — avoids importing the full TraceEvent union)
// ---------------------------------------------------------------------------

interface TraceEventLike {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Glob matching (simple * wildcards)
// ---------------------------------------------------------------------------

function compileGlob(pattern: string): RegExp {
  // Escape everything except *, then replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  if (!pattern.includes('*')) {
    return new RegExp('^' + escaped + '$');
  }
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function validateConfig(raw: unknown): GateConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('gate.json must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  const defaultBehavior = obj.default ?? 'always';
  if (defaultBehavior !== 'always' && defaultBehavior !== 'skip') {
    throw new Error(`gate.json "default" must be "always" or "skip", got: ${defaultBehavior}`);
  }

  const policies: GatePolicy[] = [];
  if (Array.isArray(obj.policies)) {
    for (const p of obj.policies) {
      policies.push(validatePolicy(p));
    }
  }

  return { policies, default: defaultBehavior };
}

function validatePolicy(raw: unknown): GatePolicy {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Each gate policy must be an object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error('Gate policy must have a "name" string');
  }

  // Validate behavior
  let behavior: GateBehavior;
  if (obj.behavior === 'always' || obj.behavior === 'skip') {
    behavior = obj.behavior;
  } else if (obj.behavior && typeof obj.behavior === 'object') {
    const b = obj.behavior as Record<string, unknown>;
    if (typeof b.debounce === 'number' && b.debounce > 0) {
      if (b.debounce < MIN_DEBOUNCE_MS) {
        throw new Error(`Policy "${obj.name}": debounce must be >= ${MIN_DEBOUNCE_MS}ms, got ${b.debounce}`);
      }
      if (b.debounce > MAX_DEBOUNCE_MS) {
        throw new Error(`Policy "${obj.name}": debounce must be <= ${MAX_DEBOUNCE_MS}ms, got ${b.debounce}`);
      }
      behavior = { debounce: b.debounce };
    } else {
      throw new Error(`Policy "${obj.name}": debounce must be a positive number`);
    }
  } else {
    behavior = 'always';
  }

  // Validate match (lenient — missing fields mean "match all")
  const match: GatePolicyMatch = {};
  if (obj.match && typeof obj.match === 'object') {
    const m = obj.match as Record<string, unknown>;
    if (Array.isArray(m.scope)) match.scope = m.scope.filter(s => typeof s === 'string');
    if (typeof m.source === 'string') match.source = m.source;
    if (typeof m.channel === 'string') match.channel = m.channel;
    if (typeof m.mount === 'string') match.mount = m.mount;
    if (typeof m.pathGlob === 'string') match.pathGlob = m.pathGlob;
    if (m.filter && typeof m.filter === 'object') {
      const f = m.filter as Record<string, unknown>;
      if ((f.type === 'text' || f.type === 'regex') && typeof f.pattern === 'string') {
        match.filter = { type: f.type, pattern: f.pattern };
        if (f.type === 'regex') {
          try { new RegExp(f.pattern as string); } catch (e) {
            throw new Error(`Policy "${obj.name}": invalid regex pattern: ${e}`);
          }
        }
      }
    }
  }

  return { name: obj.name, match, behavior };
}

// ---------------------------------------------------------------------------
// EventGate
// ---------------------------------------------------------------------------

export class EventGate {
  private configPath: string;
  private config: GateConfig;
  private compiledPolicies: CompiledPolicy[] = [];
  private configMtime: number = 0;
  private lastReloadCheck: number = 0;
  private configSource: 'file' | 'initial' | 'default' = 'default';
  private lastReloadTimestamp: number | null = null;
  private configErrors: string[] = [];

  // Debounce state
  private debounceTimers = new Map<string, DebounceState>();

  // Inference buffering
  private inferring = new Set<string>();
  private inferenceBuffer: PendingEvent[] = [];

  // Per-policy stats
  private stats = new Map<string, PolicyStats>();

  // Observability counters for events that didn't match any policy
  private totalEvaluations = 0;
  private defaultTriggered = 0;
  private defaultSkipped = 0;
  private defaultByEventType = new Map<string, { triggered: number; skipped: number }>();

  // Dependency-injected callbacks
  private emitTrace: (event: TraceEventLike) => void;
  private addMessageFn: (participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>) => unknown;
  private requestInferenceFn: (agentName: string, reason: string, source: string) => void;
  private getAgentNamesFn: () => string[];

  constructor(opts: {
    configPath: string;
    initialConfig?: GateConfig;
    emitTrace: (event: TraceEventLike) => void;
    addMessage: (participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>) => unknown;
    requestInference: (agentName: string, reason: string, source: string) => void;
    getAgentNames: () => string[];
  }) {
    this.configPath = opts.configPath;
    this.emitTrace = opts.emitTrace;
    this.addMessageFn = opts.addMessage;
    this.requestInferenceFn = opts.requestInference;
    this.getAgentNamesFn = opts.getAgentNames;

    // Seed or reconcile the on-disk config.
    //
    // First start: write `initialConfig` verbatim.
    // Subsequent starts: if the recipe/config source declares policies that
    // aren't yet in gate.json (e.g. the user edited the recipe between
    // sessions), append them by name. Existing policies are left alone so
    // user edits via `workspace--edit _config/gate.json` survive.
    // The `default` field is not reconciled — it's an explicit operator
    // choice and a recipe change shouldn't silently flip live wake
    // behavior for a session that's already been running.
    if (opts.initialConfig) {
      try {
        mkdirSync(dirname(this.configPath), { recursive: true });
        if (!existsSync(this.configPath)) {
          writeFileSync(this.configPath, JSON.stringify(opts.initialConfig, null, 2) + '\n');
        } else {
          const existing = this.loadConfig();
          if (existing) {
            const existingNames = new Set(existing.policies.map(p => p.name));
            const missing = opts.initialConfig.policies.filter(p => !existingNames.has(p.name));
            if (missing.length > 0) {
              const reconciled: GateConfig = {
                ...existing,
                policies: [...existing.policies, ...missing],
              };
              writeFileSync(this.configPath, JSON.stringify(reconciled, null, 2) + '\n');
              opts.emitTrace({
                type: 'gate:config-reconciled',
                configPath: this.configPath,
                addedPolicies: missing.map(p => p.name),
                timestamp: Date.now(),
              });
            }
          }
        }
      } catch (err) {
        this.configErrors.push(`Failed to seed/reconcile gate.json: ${err}`);
      }
    }

    // Load config
    this.config = this.loadConfig() ?? opts.initialConfig ?? { ...DEFAULT_CONFIG };
    this.compiledPolicies = this.compilePolicies(this.config);
  }

  // =========================================================================
  // Config loading
  // =========================================================================

  private loadConfig(): GateConfig | null {
    if (!existsSync(this.configPath)) {
      return null;
    }
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const stat = statSync(this.configPath);
      this.configMtime = stat.mtimeMs;
      const config = validateConfig(JSON.parse(raw));
      this.configSource = 'file';
      this.configErrors = [];
      return config;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.configErrors = [msg];
      this.emitTrace({
        type: 'gate:config-error',
        error: msg,
        configPath: this.configPath,
        timestamp: Date.now(),
      });
      return null; // Caller keeps previous config
    }
  }

  private compilePolicies(config: GateConfig): CompiledPolicy[] {
    return config.policies.map(policy => {
      const compiled: CompiledPolicy = { policy };
      if (policy.match.filter?.type === 'regex') {
        try { compiled.filterRegex = new RegExp(policy.match.filter.pattern, 'i'); } catch { /* skip */ }
      }
      if (policy.match.source) {
        compiled.sourceRegex = compileGlob(policy.match.source);
      }
      if (policy.match.channel) {
        compiled.channelRegex = compileGlob(policy.match.channel);
      }
      if (policy.match.mount) {
        compiled.mountRegex = compileGlob(policy.match.mount);
      }
      if (policy.match.pathGlob) {
        compiled.pathRegex = compileGlob(policy.match.pathGlob);
      }
      return compiled;
    });
  }

  private reloadIfChanged(): void {
    const now = Date.now();
    if (now - this.lastReloadCheck < RELOAD_THROTTLE_MS) return;
    this.lastReloadCheck = now;

    try {
      if (!existsSync(this.configPath)) return;
      const stat = statSync(this.configPath);
      if (stat.mtimeMs === this.configMtime) return;

      const newConfig = this.loadConfig();
      if (!newConfig) return; // Parse error — keep previous config

      // Clean up debounce timers for removed policies
      const newPolicyNames = new Set(newConfig.policies.map(p => p.name));
      for (const [name, state] of this.debounceTimers) {
        if (!newPolicyNames.has(name)) {
          clearTimeout(state.timer);
          if (state.events.length > 0) {
            this.deliverEvents(state.events);
          }
          this.debounceTimers.delete(name);
        }
      }

      // Reset stats for removed policies
      for (const name of this.stats.keys()) {
        if (!newPolicyNames.has(name)) {
          this.stats.delete(name);
        }
      }

      this.config = newConfig;
      this.compiledPolicies = this.compilePolicies(newConfig);
      this.lastReloadTimestamp = now;

      this.emitTrace({
        type: 'gate:config-reloaded',
        configPath: this.configPath,
        policyCount: newConfig.policies.length,
        timestamp: now,
      });
    } catch {
      // Ignore stat errors
    }
  }

  // =========================================================================
  // Policy matching — first match wins
  // =========================================================================

  private matchPolicy(info: GateEventInfo): GatePolicy | null {
    for (const compiled of this.compiledPolicies) {
      if (this.compiledMatches(compiled, info)) {
        return compiled.policy;
      }
    }
    return null;
  }

  private compiledMatches(compiled: CompiledPolicy, info: GateEventInfo): boolean {
    const match = compiled.policy.match;

    // Scope check
    if (match.scope && match.scope.length > 0 && !match.scope.includes(info.eventType)) {
      return false;
    }

    // Source check (serverId)
    if (compiled.sourceRegex && !compiled.sourceRegex.test(info.serverId)) {
      return false;
    }

    // Channel check
    if (compiled.channelRegex && !compiled.channelRegex.test(info.channelId)) {
      return false;
    }

    // Mount check (workspace fs events)
    if (compiled.mountRegex) {
      if (!info.mount || !compiled.mountRegex.test(info.mount)) {
        return false;
      }
    }

    // Path glob check — matches if ANY path matches
    if (compiled.pathRegex) {
      const paths = info.paths;
      if (!paths || paths.length === 0) return false;
      const anyMatch = paths.some(p => compiled.pathRegex!.test(p));
      if (!anyMatch) return false;
    }

    // Content filter check
    if (match.filter) {
      if (match.filter.type === 'text') {
        if (!info.content.toLowerCase().includes(match.filter.pattern.toLowerCase())) {
          return false;
        }
      } else if (compiled.filterRegex) {
        if (!compiled.filterRegex.test(info.content)) {
          return false;
        }
      } else {
        return false; // Regex failed to compile
      }
    }

    return true;
  }

  // =========================================================================
  // Evaluate — main entry point
  // =========================================================================

  evaluate(info: GateEventInfo): GateDecision {
    this.reloadIfChanged();

    const policy = this.matchPolicy(info);
    const decision = this.computeDecision(policy, info);

    this.totalEvaluations++;
    if (!policy) {
      const bucket = this.defaultByEventType.get(info.eventType)
        ?? { triggered: 0, skipped: 0 };
      if (decision.trigger) {
        this.defaultTriggered++;
        bucket.triggered++;
      } else {
        this.defaultSkipped++;
        bucket.skipped++;
      }
      this.defaultByEventType.set(info.eventType, bucket);
    }

    this.emitTrace({
      type: 'gate:decision',
      eventType: info.eventType,
      serverId: info.serverId || undefined,
      channelId: info.channelId || undefined,
      matchedPolicy: decision.policyName,
      trigger: decision.trigger,
      behavior: typeof decision.behavior === 'object' ? `debounce:${decision.behavior.debounce}` : decision.behavior,
      timestamp: Date.now(),
    });

    return decision;
  }

  private computeDecision(policy: GatePolicy | null, info: GateEventInfo): GateDecision {
    if (!policy) {
      const trigger = (this.config.default ?? 'always') === 'always';
      return { trigger, policyName: null, behavior: this.config.default ?? 'always' };
    }

    // Record stats
    const policyStats = this.stats.get(policy.name) ?? { matchCount: 0, lastMatchTimestamp: null };
    policyStats.matchCount++;
    policyStats.lastMatchTimestamp = Date.now();
    this.stats.set(policy.name, policyStats);

    // Legacy trace kept for backward compatibility with existing consumers.
    this.emitTrace({
      type: 'gate:policy-matched',
      policyName: policy.name,
      behavior: typeof policy.behavior === 'object' ? `debounce:${policy.behavior.debounce}` : policy.behavior,
      eventType: info.eventType,
      source: info.serverId || undefined,
      timestamp: Date.now(),
    });

    if (policy.behavior === 'skip') {
      return { trigger: false, policyName: policy.name, behavior: 'skip' };
    }

    if (policy.behavior === 'always') {
      return { trigger: true, policyName: policy.name, behavior: 'always' };
    }

    // Debounce
    this.handleDebounce(policy, info);
    return { trigger: false, policyName: policy.name, behavior: policy.behavior };
  }

  // =========================================================================
  // shouldTriggerInference callback adapter
  // =========================================================================

  /**
   * Returns a callback compatible with McplServerConfig.shouldTriggerInference.
   * Used by the framework to wire the gate into PushHandler and ChannelRegistry.
   */
  asShouldTriggerCallback(): (content: string, metadata: Record<string, unknown>) => boolean {
    return (content: string, metadata: Record<string, unknown>): boolean => {
      const decision = this.evaluate({
        content,
        eventType: (metadata.eventType as string) ?? 'unknown',
        serverId: (metadata.serverId as string) ?? '',
        channelId: (metadata.channelId as string) ?? '',
        metadata,
      });
      return decision.trigger;
    };
  }

  // =========================================================================
  // Debounce
  // =========================================================================

  private handleDebounce(policy: GatePolicy, info: GateEventInfo): void {
    const debounceMs = (policy.behavior as { debounce: number }).debounce;

    const event: PendingEvent = {
      policyName: policy.name,
      content: info.content.length > MAX_CONTENT_SNIPPET
        ? info.content.slice(0, MAX_CONTENT_SNIPPET) + '...'
        : info.content,
      eventType: info.eventType,
      timestamp: Date.now(),
    };

    const existing = this.debounceTimers.get(policy.name);
    if (existing) {
      clearTimeout(existing.timer);
      existing.events.push(event);
      existing.timer = setTimeout(() => this.fireDebounce(policy.name), debounceMs);
    } else {
      const timer = setTimeout(() => this.fireDebounce(policy.name), debounceMs);
      this.debounceTimers.set(policy.name, { timer, events: [event] });
    }
  }

  private fireDebounce(policyName: string): void {
    const state = this.debounceTimers.get(policyName);
    if (!state || state.events.length === 0) {
      this.debounceTimers.delete(policyName);
      return;
    }

    const events = state.events;
    this.debounceTimers.delete(policyName);

    // If any agent is currently inferring, buffer for later (with cap)
    if (this.inferring.size > 0) {
      this.bufferForInference(events);
      return;
    }

    this.deliverEvents(events);

    this.emitTrace({
      type: 'gate:debounce-delivered',
      policyName,
      eventCount: events.length,
      timestamp: Date.now(),
    });
  }

  // =========================================================================
  // Event delivery
  // =========================================================================

  private deliverEvents(events: PendingEvent[]): void {
    if (events.length === 0) return;

    const policyNames = [...new Set(events.map(e => e.policyName))];
    const lines = events
      .map(e => `- [${e.policyName}] (${e.eventType}): ${e.content}`)
      .join('\n');

    const text = `[Gate: ${events.length} event${events.length > 1 ? 's' : ''} matched]\n\n${lines}`;

    this.addMessageFn('user', [{ type: 'text', text }], {
      source: 'gate:debounce',
      policies: policyNames,
    });

    for (const agentName of this.getAgentNamesFn()) {
      this.requestInferenceFn(agentName, 'gate:debounce', 'gate');
    }
  }

  // =========================================================================
  // Inference lifecycle
  // =========================================================================

  onInferenceStarted(agentName: string): void {
    this.inferring.add(agentName);
  }

  onInferenceEnded(agentName: string): void {
    this.inferring.delete(agentName);

    // Flush inference buffer if no agents are inferring
    if (this.inferring.size === 0 && this.inferenceBuffer.length > 0) {
      const events = this.inferenceBuffer.splice(0);
      // Defer to avoid re-entrancy inside trace callbacks
      queueMicrotask(() => this.deliverEvents(events));
    }
  }

  // =========================================================================
  // Inference buffer cap
  // =========================================================================

  /** Called internally when debounce fires during inference. */
  private bufferForInference(events: PendingEvent[]): void {
    for (const event of events) {
      if (this.inferenceBuffer.length >= MAX_INFERENCE_BUFFER) {
        this.inferenceBuffer.shift(); // Drop oldest
      }
      this.inferenceBuffer.push(event);
    }
  }

  // =========================================================================
  // Tool: gate:status
  // =========================================================================

  getToolDefinition(): ToolDefinition {
    return {
      name: 'gate:status',
      description: 'Show the current EventGate configuration, per-policy match counts, debounce state, and any config errors.',
      inputSchema: {
        type: 'object',
      },
    };
  }

  async handleToolCall(): Promise<{ success: boolean; data?: GateStatus; error?: string }> {
    const status = this.getStatus();
    return { success: true, data: status };
  }

  getStatus(): GateStatus {
    const policies: GatePolicyStats[] = this.config.policies.map(p => {
      const stats = this.stats.get(p.name);
      const debounce = this.debounceTimers.get(p.name);
      const result: GatePolicyStats = {
        name: p.name,
        behavior: p.behavior,
        matchCount: stats?.matchCount ?? 0,
        lastMatchTimestamp: stats?.lastMatchTimestamp ?? null,
      };
      if (typeof p.behavior === 'object' && 'debounce' in p.behavior) {
        result.debounceState = {
          pendingCount: debounce?.events.length ?? 0,
          nextDeliveryMs: null, // Timer internals not easily inspectable
        };
      }
      return result;
    });

    const byEventType: Record<string, { triggered: number; skipped: number }> = {};
    for (const [k, v] of this.defaultByEventType) byEventType[k] = { ...v };

    return {
      configPath: this.configPath,
      configSource: this.configSource,
      lastReloadTimestamp: this.lastReloadTimestamp,
      default: this.config.default ?? 'always',
      policies,
      errors: [...this.configErrors],
      totalEvaluations: this.totalEvaluations,
      defaultDecisions: {
        triggered: this.defaultTriggered,
        skipped: this.defaultSkipped,
        byEventType,
      },
    };
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  dispose(): void {
    for (const state of this.debounceTimers.values()) {
      clearTimeout(state.timer);
    }
    this.debounceTimers.clear();
    this.inferenceBuffer = [];
  }
}
