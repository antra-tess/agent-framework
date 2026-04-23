/**
 * Tool allow/deny policy for MCPL servers.
 *
 * `enabledTools` and `disabledTools` on McplServerConfig hold bare tool names
 * (no toolPrefix) with `*` substring wildcards. This module owns the predicate
 * used at both tool-list time and dispatch time.
 *
 * Semantics:
 *   - No fields set                 → all tools allowed.
 *   - Only enabledTools set         → tool must match at least one pattern.
 *   - Only disabledTools set        → tool must NOT match any pattern.
 *   - Both set                      → must match enabledTools AND not match disabledTools.
 *                                     (deny wins on overlap.)
 */

/**
 * Compile a pattern with `*` substring wildcards into a regex.
 * `*` matches any run of characters (including empty); other characters are literal.
 */
function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function anyMatch(patterns: string[], name: string): boolean {
  for (const p of patterns) {
    if (compilePattern(p).test(name)) return true;
  }
  return false;
}

export interface ToolPolicy {
  enabledTools?: string[];
  disabledTools?: string[];
}

/**
 * Returns true if `bareToolName` (server-native name, no prefix) is allowed
 * under the supplied policy.
 */
export function isToolAllowed(bareToolName: string, policy: ToolPolicy | undefined): boolean {
  if (!policy) return true;
  const { enabledTools, disabledTools } = policy;

  if (disabledTools && disabledTools.length > 0 && anyMatch(disabledTools, bareToolName)) {
    return false;
  }
  if (enabledTools && enabledTools.length > 0) {
    return anyMatch(enabledTools, bareToolName);
  }
  return true;
}
