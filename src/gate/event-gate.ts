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

/** Token bucket for one (policy, key) pair under a rate_limit behavior. */
interface RateBucket {
  /** Tokens currently available. */
  tokens: number;
  /** Last epoch-ms timestamp the bucket was refilled. */
  lastRefill: number;
}

/** Synthetic key used when a policy has no `keyBy` or the field is missing. */
const SHARED_BUCKET_KEY = '__shared__';

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

/**
 * Truthiness for `metadataTrue` matching. Stricter than JS `Boolean(x)`:
 * empty strings, empty arrays, and empty objects all count as false, so
 * `metadataTrue: ["mentionIds"]` doesn't match every event that happens
 * to carry an empty `mentionIds: []` array.
 */
function isMetadataTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Compact, log-friendly serialization of a GateBehavior. */
function formatBehavior(b: import('./types.js').GateBehavior): string {
  if (typeof b === 'string') return b;
  if ('debounce' in b) return `debounce:${b.debounce}`;
  if ('rate_limit' in b) {
    const k = b.rate_limit.keyBy ? `,keyBy:${b.rate_limit.keyBy}` : '';
    return `rate_limit:${b.rate_limit.tokens}/${b.rate_limit.refillIntervalMs}ms${k}`;
  }
  if ('passive_sample' in b) {
    const k = b.passive_sample.keyBy ? `,keyBy:${b.passive_sample.keyBy}` : '';
    return `passive_sample:${b.passive_sample.every}${k}`;
  }
  return 'unknown';
}

/**
 * Stable fingerprint for a GateBehavior, used during reload to detect
 * config changes that invalidate per-policy state. JSON.stringify is
 * deterministic for our small, flat behavior shapes — keys appear in
 * declaration order — so this is enough to spot any change in tokens,
 * refillIntervalMs, keyBy, every, or debounce duration.
 */
function behaviorFingerprint(b: import('./types.js').GateBehavior): string {
  return typeof b === 'string' ? b : JSON.stringify(b);
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
    if ('debounce' in b) {
      if (typeof b.debounce !== 'number' || b.debounce <= 0) {
        throw new Error(`Policy "${obj.name}": debounce must be a positive number`);
      }
      if (b.debounce < MIN_DEBOUNCE_MS) {
        throw new Error(`Policy "${obj.name}": debounce must be >= ${MIN_DEBOUNCE_MS}ms, got ${b.debounce}`);
      }
      if (b.debounce > MAX_DEBOUNCE_MS) {
        throw new Error(`Policy "${obj.name}": debounce must be <= ${MAX_DEBOUNCE_MS}ms, got ${b.debounce}`);
      }
      behavior = { debounce: b.debounce };
    } else if ('rate_limit' in b) {
      const rl = b.rate_limit;
      if (!rl || typeof rl !== 'object') {
        throw new Error(`Policy "${obj.name}": rate_limit must be an object`);
      }
      const conf = rl as Record<string, unknown>;
      if (typeof conf.tokens !== 'number' || !Number.isFinite(conf.tokens) || conf.tokens <= 0) {
        throw new Error(`Policy "${obj.name}": rate_limit.tokens must be a positive number`);
      }
      if (typeof conf.refillIntervalMs !== 'number' || !Number.isFinite(conf.refillIntervalMs) || conf.refillIntervalMs <= 0) {
        throw new Error(`Policy "${obj.name}": rate_limit.refillIntervalMs must be a positive number`);
      }
      const out: { tokens: number; refillIntervalMs: number; keyBy?: string } = {
        tokens: conf.tokens,
        refillIntervalMs: conf.refillIntervalMs,
      };
      if (typeof conf.keyBy === 'string' && conf.keyBy.length > 0) {
        out.keyBy = conf.keyBy;
      }
      behavior = { rate_limit: out };
    } else if ('passive_sample' in b) {
      const ps = b.passive_sample;
      if (!ps || typeof ps !== 'object') {
        throw new Error(`Policy "${obj.name}": passive_sample must be an object`);
      }
      const conf = ps as Record<string, unknown>;
      if (typeof conf.every !== 'number' || !Number.isInteger(conf.every) || conf.every <= 0) {
        throw new Error(`Policy "${obj.name}": passive_sample.every must be a positive integer`);
      }
      const out: { every: number; keyBy?: string } = { every: conf.every };
      if (typeof conf.keyBy === 'string' && conf.keyBy.length > 0) {
        out.keyBy = conf.keyBy;
      }
      behavior = { passive_sample: out };
    } else {
      throw new Error(`Policy "${obj.name}": unknown behavior — expected always | skip | { debounce } | { rate_limit } | { passive_sample }`);
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
    if (Array.isArray(m.metadataTrue)) {
      const fields = m.metadataTrue.filter((s): s is string => typeof s === 'string' && s.length > 0);
      if (fields.length > 0) match.metadataTrue = fields;
    }
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

  // Validate resets (optional list of policy names; unknown names are ignored
  // at runtime so reload races don't blow up).
  let resets: string[] | undefined;
  if (Array.isArray(obj.resets)) {
    const names = obj.resets.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (names.length > 0) resets = names;
  }

  const policy: GatePolicy = { name: obj.name, match, behavior };
  if (resets) policy.resets = resets;
  return policy;
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

  // Rate-limit state — policy name → key → bucket.
  private rateLimitBuckets = new Map<string, Map<string, RateBucket>>();
  // Passive-sample state — policy name → key → counter (count since last fire).
  private passiveSampleCounters = new Map<string, Map<string, number>>();
  // Per-policy denial / fire counters for status reporting.
  private rateLimitDenied = new Map<string, number>();
  private passiveSampleFires = new Map<string, number>();

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
  /** Clock injection — keeps the new rate_limit / passive_sample paths
   *  testable without monkey-patching Date.now globally. */
  private now: () => number;

  constructor(opts: {
    configPath: string;
    initialConfig?: GateConfig;
    emitTrace: (event: TraceEventLike) => void;
    addMessage: (participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>) => unknown;
    requestInference: (agentName: string, reason: string, source: string) => void;
    getAgentNames: () => string[];
    /** Optional clock — defaults to Date.now. Tests inject for deterministic time. */
    now?: () => number;
  }) {
    this.configPath = opts.configPath;
    this.emitTrace = opts.emitTrace;
    this.addMessageFn = opts.addMessage;
    this.requestInferenceFn = opts.requestInference;
    this.getAgentNamesFn = opts.getAgentNames;
    this.now = opts.now ?? (() => Date.now());

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
        const msg = err instanceof Error ? err.message : String(err);
        this.configErrors.push(`Failed to seed/reconcile gate.json: ${msg}`);
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

      // Capture old policies' behavior fingerprints before any state
      // mutation — needed to detect kept policies whose parameters changed.
      const oldBehaviorByName = new Map<string, string>();
      for (const p of this.config.policies) {
        oldBehaviorByName.set(p.name, behaviorFingerprint(p.behavior));
      }

      // Clean up state for REMOVED policies (gone from new config entirely).
      const newPolicyNames = new Set(newConfig.policies.map(p => p.name));
      const removedPolicies: string[] = [];
      for (const oldName of oldBehaviorByName.keys()) {
        if (!newPolicyNames.has(oldName)) {
          this.clearPolicyState(oldName, { deliverPendingDebounce: true });
          this.stats.delete(oldName);
          removedPolicies.push(oldName);
        }
      }

      // Clean up state for KEPT policies whose behavior parameters changed.
      // Without this, a tokens 100→5 edit (or keyBy switch, or every 10→3,
      // etc.) wouldn't take effect until existing buckets/counters drained.
      // Stats are preserved — matchCount is historical, not live state.
      const stateClearedPolicies: string[] = [];
      for (const newPolicy of newConfig.policies) {
        const oldHash = oldBehaviorByName.get(newPolicy.name);
        if (oldHash === undefined) continue; // new policy, no state to clear
        const newHash = behaviorFingerprint(newPolicy.behavior);
        if (oldHash !== newHash) {
          this.clearPolicyState(newPolicy.name, { deliverPendingDebounce: true });
          stateClearedPolicies.push(newPolicy.name);
        }
      }

      this.config = newConfig;
      this.compiledPolicies = this.compilePolicies(newConfig);
      this.lastReloadTimestamp = now;

      this.emitTrace({
        type: 'gate:config-reloaded',
        configPath: this.configPath,
        policyCount: newConfig.policies.length,
        removedPolicies: removedPolicies.length > 0 ? removedPolicies : undefined,
        stateClearedPolicies:
          stateClearedPolicies.length > 0 ? stateClearedPolicies : undefined,
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

    // Metadata-truthy check — match if ANY listed field is truthy.
    // Uses isMetadataTruthy so empty arrays / strings / objects are treated
    // as falsy (matches user expectation, not raw JS Boolean coercion).
    if (match.metadataTrue && match.metadataTrue.length > 0) {
      const md = info.metadata ?? {};
      const anyTrue = match.metadataTrue.some(field => isMetadataTruthy(md[field]));
      if (!anyTrue) return false;
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
      behavior: formatBehavior(decision.behavior),
      timestamp: this.now(),
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
    policyStats.lastMatchTimestamp = this.now();
    this.stats.set(policy.name, policyStats);

    // Legacy trace kept for backward compatibility with existing consumers.
    this.emitTrace({
      type: 'gate:policy-matched',
      policyName: policy.name,
      behavior: formatBehavior(policy.behavior),
      eventType: info.eventType,
      source: info.serverId || undefined,
      timestamp: this.now(),
    });

    if (policy.behavior === 'skip') {
      return { trigger: false, policyName: policy.name, behavior: 'skip' };
    }

    if (policy.behavior === 'always') {
      this.applyResets(policy);
      return { trigger: true, policyName: policy.name, behavior: 'always' };
    }

    if (typeof policy.behavior === 'object') {
      if ('debounce' in policy.behavior) {
        this.handleDebounce(policy, info);
        return { trigger: false, policyName: policy.name, behavior: policy.behavior };
      }
      if ('rate_limit' in policy.behavior) {
        return this.applyRateLimit(policy, info, policy.behavior.rate_limit);
      }
      if ('passive_sample' in policy.behavior) {
        return this.applyPassiveSample(policy, info, policy.behavior.passive_sample);
      }
    }

    // Unknown behavior shape — should be unreachable thanks to validation,
    // but be defensive: treat as skip rather than crash on a bad config.
    return { trigger: false, policyName: policy.name, behavior: 'skip' };
  }

  // =========================================================================
  // rate_limit + passive_sample + resets
  // =========================================================================

  /** Resolve the partition key for keyBy-style behaviors. */
  private resolveKey(metadata: Record<string, unknown> | undefined, keyBy: string | undefined): string {
    if (!keyBy) return SHARED_BUCKET_KEY;
    const value = metadata?.[keyBy];
    if (value === undefined || value === null || value === '') return SHARED_BUCKET_KEY;
    return String(value);
  }

  private applyRateLimit(
    policy: GatePolicy,
    info: GateEventInfo,
    config: { tokens: number; refillIntervalMs: number; keyBy?: string },
  ): GateDecision {
    const key = this.resolveKey(info.metadata, config.keyBy);
    let buckets = this.rateLimitBuckets.get(policy.name);
    if (!buckets) {
      buckets = new Map();
      this.rateLimitBuckets.set(policy.name, buckets);
    }

    const now = this.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: config.tokens, lastRefill: now };
      buckets.set(key, bucket);
    } else if (bucket.tokens < config.tokens) {
      const elapsed = now - bucket.lastRefill;
      if (elapsed > 0) {
        const tokensToAdd = Math.floor(elapsed / config.refillIntervalMs);
        if (tokensToAdd > 0) {
          bucket.tokens = Math.min(config.tokens, bucket.tokens + tokensToAdd);
          bucket.lastRefill += tokensToAdd * config.refillIntervalMs;
        }
      }
    } else {
      // Bucket already full — keep the refill clock fresh so the next
      // drain starts from "now" rather than ancient history.
      bucket.lastRefill = now;
    }

    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      this.applyResets(policy);
      return { trigger: true, policyName: policy.name, behavior: policy.behavior };
    }

    this.rateLimitDenied.set(policy.name, (this.rateLimitDenied.get(policy.name) ?? 0) + 1);
    return { trigger: false, policyName: policy.name, behavior: policy.behavior };
  }

  private applyPassiveSample(
    policy: GatePolicy,
    info: GateEventInfo,
    config: { every: number; keyBy?: string },
  ): GateDecision {
    const key = this.resolveKey(info.metadata, config.keyBy);
    let counters = this.passiveSampleCounters.get(policy.name);
    if (!counters) {
      counters = new Map();
      this.passiveSampleCounters.set(policy.name, counters);
    }

    const next = (counters.get(key) ?? 0) + 1;
    if (next >= config.every) {
      counters.set(key, 0);
      this.passiveSampleFires.set(policy.name, (this.passiveSampleFires.get(policy.name) ?? 0) + 1);
      this.applyResets(policy);
      return { trigger: true, policyName: policy.name, behavior: policy.behavior };
    }
    counters.set(key, next);
    return { trigger: false, policyName: policy.name, behavior: policy.behavior };
  }

  /**
   * Clear bucket / counter state for the policies named in `policy.resets`.
   * Called when a policy fires (decision.trigger === true). Unknown names
   * are silently ignored — gate.json reload could remove them.
   */
  private applyResets(policy: GatePolicy): void {
    if (!policy.resets || policy.resets.length === 0) return;
    for (const target of policy.resets) {
      this.rateLimitBuckets.delete(target);
      this.passiveSampleCounters.delete(target);
    }
  }

  /**
   * Clear ALL per-policy state (debounce timer, rate-limit buckets,
   * passive-sample counters, denial / fire counters) for one policy.
   * Used by reloadIfChanged when a policy is removed or its behavior
   * params change. Stats (matchCount, lastMatchTimestamp) are preserved
   * — those are historical and shouldn't reset on a config edit.
   */
  private clearPolicyState(
    name: string,
    options: { deliverPendingDebounce: boolean },
  ): void {
    const debounce = this.debounceTimers.get(name);
    if (debounce) {
      clearTimeout(debounce.timer);
      if (options.deliverPendingDebounce && debounce.events.length > 0) {
        this.deliverEvents(debounce.events);
      }
      this.debounceTimers.delete(name);
    }
    this.rateLimitBuckets.delete(name);
    this.passiveSampleCounters.delete(name);
    this.rateLimitDenied.delete(name);
    this.passiveSampleFires.delete(name);
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
      name: 'gate_status',
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
      if (typeof p.behavior === 'object' && 'rate_limit' in p.behavior) {
        result.rateLimitState = {
          bucketCount: this.rateLimitBuckets.get(p.name)?.size ?? 0,
          deniedCount: this.rateLimitDenied.get(p.name) ?? 0,
        };
      }
      if (typeof p.behavior === 'object' && 'passive_sample' in p.behavior) {
        result.passiveSampleState = {
          counterCount: this.passiveSampleCounters.get(p.name)?.size ?? 0,
          fireCount: this.passiveSampleFires.get(p.name) ?? 0,
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
    this.rateLimitBuckets.clear();
    this.passiveSampleCounters.clear();
    this.rateLimitDenied.clear();
    this.passiveSampleFires.clear();
    this.inferenceBuffer = [];
  }
}
