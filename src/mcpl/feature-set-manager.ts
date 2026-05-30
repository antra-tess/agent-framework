/**
 * FeatureSetManager — Permission gate for MCPL feature sets.
 *
 * Manages per-server feature set state: which feature sets each server declares,
 * which are enabled/disabled, and validates inbound messages against that state.
 *
 * Spec references: Section 6 (Feature Sets), Appendix A (Error Codes).
 */

import type {
  McplCapabilities,
  FeatureSetDeclaration,
  FeatureSetsUpdateParams,
  FeatureSetsChangedParams,
} from './types.js';

import {
  FEATURE_SET_NOT_ENABLED,
  UNKNOWN_FEATURE_SET,
} from './errors.js';

// ============================================================================
// Error Class
// ============================================================================

/**
 * Error thrown when a feature set validation fails.
 * Carries the JSON-RPC error code and the offending feature set name.
 */
export class McplFeatureSetError extends Error {
  constructor(
    public readonly code: number,
    public readonly featureSet: string,
    message: string
  ) {
    super(message);
    this.name = 'McplFeatureSetError';
  }
}

// ============================================================================
// Internal Types
// ============================================================================

/** Per-server tracking state. */
interface ServerState {
  /** All declared feature sets (keyed by name). */
  declared: Record<string, FeatureSetDeclaration>;
  /** Set of currently enabled feature set names. */
  enabled: Set<string>;
}

// ============================================================================
// Wildcard Matching
// ============================================================================

/**
 * Check whether a wildcard pattern matches a feature set name.
 *
 * Rules:
 *   - Split both pattern and name on `.`
 *   - `*` in a pattern segment matches exactly one segment (any value)
 *   - Literal segments must match exactly
 *   - Pattern and name must have the same number of segments
 *     (unless the last pattern segment is `*`, which matches one segment)
 *
 * Examples:
 *   `memory.*` matches `memory.retrieval` but not `memory.a.b`
 *   `memory.retrieval` matches only `memory.retrieval`
 */
function wildcardMatch(pattern: string, name: string): boolean {
  const patternParts = pattern.split('.');
  const nameParts = name.split('.');

  if (patternParts.length !== nameParts.length) {
    return false;
  }

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p === '*') {
      // Wildcard segment matches any single segment
      continue;
    }
    if (p !== nameParts[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Find all declared feature set names that match any of the given patterns.
 * Patterns may contain wildcards (e.g., `memory.*`).
 */
function resolvePatterns(
  patterns: string[],
  declared: Record<string, FeatureSetDeclaration>
): string[] {
  const matched = new Set<string>();
  const declaredNames = Object.keys(declared);

  for (const pattern of patterns) {
    for (const name of declaredNames) {
      if (wildcardMatch(pattern, name)) {
        matched.add(name);
      }
    }
  }

  return [...matched];
}

// ============================================================================
// FeatureSetManager
// ============================================================================

/**
 * Manages feature set state across all MCPL servers.
 *
 * This is the permission gate that all MCPL interactions pass through.
 * Every inbound server message tagged with a `featureSet` must be validated
 * through this manager before processing.
 */
export class FeatureSetManager {
  /** Per-server state, keyed by server ID. */
  private servers = new Map<string, ServerState>();

  /**
   * Initialize a server's feature set state from its capabilities and host config.
   *
   * Called after a server connects and advertises its capabilities.
   * Returns the `FeatureSetsUpdateParams` that should be sent to the server
   * via `featureSets/update`.
   *
   * Initialization logic:
   * 1. Store all declared feature sets from capabilities.
   * 2. If `config.enabledFeatureSets` is provided, enable matching sets (supports wildcards).
   * 3. If `config.disabledFeatureSets` is provided, disable matching sets (supports wildcards).
   * 4. Feature sets not mentioned in either list default to disabled.
   */
  initializeServer(
    serverId: string,
    capabilities: McplCapabilities,
    config?: { enabledFeatureSets?: string[]; disabledFeatureSets?: string[] }
  ): FeatureSetsUpdateParams {
    // Cross-package compat: agent-framework's McplCapabilities types
    // featureSets as Record<string, FeatureSetDeclaration>, but mcpl-core-ts
    // (used by discord-mcpl and other servers) types it as an array of
    // {name, ...FeatureSetDeclaration}. Both representations arrive over
    // the wire. Normalize to Record here so downstream code (resolvePatterns,
    // validateInbound, etc.) can rely on the keyed shape.
    const featureSetsRaw = capabilities.featureSets ?? {};
    const declared: Record<string, FeatureSetDeclaration> = Array.isArray(featureSetsRaw)
      ? Object.fromEntries(
          (featureSetsRaw as ReadonlyArray<FeatureSetDeclaration & { name: string }>).map(
            (d) => [d.name, d],
          ),
        )
      : featureSetsRaw;

    const state: ServerState = {
      declared: { ...declared },
      enabled: new Set<string>(),
    };

    // Resolve which feature sets to enable
    const enablePatterns = config?.enabledFeatureSets ?? [];
    const disablePatterns = config?.disabledFeatureSets ?? [];

    const toEnable = resolvePatterns(enablePatterns, declared);
    const toDisable = resolvePatterns(disablePatterns, declared);

    // Enable matching sets
    for (const name of toEnable) {
      state.enabled.add(name);
    }

    // Disable explicitly overrides enable (disable wins on conflict)
    for (const name of toDisable) {
      state.enabled.delete(name);
    }

    this.servers.set(serverId, state);

    // Build the update params to send to the server
    const enabled = [...state.enabled];
    const allDeclared = Object.keys(declared);
    const disabled = allDeclared.filter((n) => !state.enabled.has(n));

    const params: FeatureSetsUpdateParams = {};
    if (enabled.length > 0) {
      params.enabled = enabled;
    }
    if (disabled.length > 0) {
      params.disabled = disabled;
    }

    return params;
  }

  /**
   * Remove all tracking state for a server.
   * Called when a server disconnects.
   */
  removeServer(serverId: string): void {
    this.servers.delete(serverId);
  }

  /**
   * Check whether a feature set is enabled for a server.
   * Returns false if the server is unknown or the feature set is not enabled.
   */
  isEnabled(serverId: string, featureSet: string): boolean {
    const state = this.servers.get(serverId);
    if (!state) {
      return false;
    }
    return state.enabled.has(featureSet);
  }

  /**
   * Validate that an inbound message's feature set is declared and enabled.
   *
   * @throws McplFeatureSetError with code -32003 if the feature set is unknown
   * @throws McplFeatureSetError with code -32001 if the feature set is not enabled
   */
  validateInbound(serverId: string, featureSet: string): void {
    const state = this.servers.get(serverId);

    if (!state) {
      throw new McplFeatureSetError(
        UNKNOWN_FEATURE_SET,
        featureSet,
        `Unknown server: ${serverId}`
      );
    }

    if (!(featureSet in state.declared)) {
      throw new McplFeatureSetError(
        UNKNOWN_FEATURE_SET,
        featureSet,
        `Unknown feature set: ${featureSet}`
      );
    }

    if (!state.enabled.has(featureSet)) {
      throw new McplFeatureSetError(
        FEATURE_SET_NOT_ENABLED,
        featureSet,
        `Feature set not enabled: ${featureSet}`
      );
    }
  }

  /**
   * Enable feature sets for a server (supports wildcard patterns).
   * Only declared feature sets can be enabled.
   */
  enable(serverId: string, featureSets: string[]): void {
    const state = this.servers.get(serverId);
    if (!state) {
      return;
    }

    const resolved = resolvePatterns(featureSets, state.declared);
    for (const name of resolved) {
      state.enabled.add(name);
    }
  }

  /**
   * Disable feature sets for a server (supports wildcard patterns).
   * Only declared feature sets can be disabled.
   */
  disable(serverId: string, featureSets: string[]): void {
    const state = this.servers.get(serverId);
    if (!state) {
      return;
    }

    const resolved = resolvePatterns(featureSets, state.declared);
    for (const name of resolved) {
      state.enabled.delete(name);
    }
  }

  /**
   * Handle a `featureSets/changed` notification from a server.
   *
   * - Adds new feature sets from `params.added` (default to disabled).
   * - Removes feature sets listed in `params.removed`.
   */
  handleFeatureSetsChanged(
    serverId: string,
    params: FeatureSetsChangedParams
  ): void {
    const state = this.servers.get(serverId);
    if (!state) {
      return;
    }

    // Add new feature sets (default to disabled)
    if (params.added) {
      for (const [name, declaration] of Object.entries(params.added)) {
        state.declared[name] = declaration;
        // New feature sets default to disabled — do not add to enabled set
      }
    }

    // Remove feature sets
    if (params.removed) {
      for (const name of params.removed) {
        delete state.declared[name];
        state.enabled.delete(name);
      }
    }
  }

  /**
   * Get all declared feature sets for a server.
   * Returns null if the server is unknown.
   */
  getDeclaredFeatureSets(
    serverId: string
  ): Record<string, FeatureSetDeclaration> | null {
    const state = this.servers.get(serverId);
    if (!state) {
      return null;
    }
    return { ...state.declared };
  }

  /**
   * Get the names of all enabled feature sets for a server.
   * Returns an empty array if the server is unknown.
   */
  getEnabledFeatureSets(serverId: string): string[] {
    const state = this.servers.get(serverId);
    if (!state) {
      return [];
    }
    return [...state.enabled];
  }
}
