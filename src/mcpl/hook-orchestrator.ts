/**
 * HookOrchestrator — manages before/after inference fan-out to MCPL servers.
 *
 * This is the bridge between the MCPL protocol and the agent-framework inference
 * pipeline. It collects ContextInjection[] from MCPL servers via beforeInference
 * and feeds them into context-manager's compile(). After inference, it notifies
 * servers of the result via afterInference.
 *
 * Design principles:
 * - Fail-open: timeouts and errors never block inference
 * - Parallel fan-out with per-server timeouts
 * - Loop prevention: rejects inference/request while inside a hook
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { ContextInjection } from '@animalabs/context-manager';

import type {
  McplContentBlock,
  McplContextInjection,
  BeforeInferenceParams,
  BeforeInferenceResult,
  AfterInferenceParams,
  AfterInferenceResult,
} from './types.js';
import type { McplServerRegistry } from './server-registry.js';
import type { McplServerConnection } from './server-connection.js';
import type { FeatureSetManager } from './feature-set-manager.js';

/** Timeout for beforeInference per server (fail-open). */
const BEFORE_INFERENCE_TIMEOUT_MS = 5_000;

/** Timeout for blocking afterInference per server. */
const AFTER_INFERENCE_BLOCKING_TIMEOUT_MS = 10_000;

/**
 * Races a promise against a timeout. Rejects with a descriptive error on timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ============================================================================
// Content conversion: McplContentBlock / McplContextInjection → membrane types
// ============================================================================

/**
 * Convert a single MCPL wire-format content block to a membrane ContentBlock.
 */
function convertBlock(block: McplContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'image':
      if (block.data && block.mimeType) {
        return {
          type: 'image',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        };
      }
      if (block.uri) {
        return {
          type: 'image',
          source: { type: 'url', url: block.uri },
        };
      }
      // Malformed image block — degrade to text
      return { type: 'text', text: '[Image: missing data]' };

    case 'audio':
      if (block.data && block.mimeType) {
        return {
          type: 'audio',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        };
      }
      // Audio without inline data — degrade to text
      return { type: 'text', text: `[Audio: ${block.uri ?? 'missing data'}]` };

    case 'resource':
      // Resources don't have a direct membrane equivalent — degrade to text
      return { type: 'text', text: `[Resource: ${block.uri}]` };
  }
}

/**
 * Convert MCPL injection content (string shorthand or block array) to membrane ContentBlock[].
 */
function convertContent(content: string | McplContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content.map(convertBlock);
}

/**
 * Convert an MCPL wire-format context injection to a context-manager ContextInjection.
 */
function convertMcplInjection(mcplInj: McplContextInjection): ContextInjection {
  return {
    namespace: mcplInj.namespace,
    position: mcplInj.position,
    content: convertContent(mcplInj.content),
    metadata: mcplInj.metadata,
  };
}

// ============================================================================
// HookOrchestrator
// ============================================================================

export class HookOrchestrator {
  private registry: McplServerRegistry;
  private featureSetManager: FeatureSetManager;
  private _isInHook = false;

  constructor(registry: McplServerRegistry, featureSetManager: FeatureSetManager) {
    this.registry = registry;
    this.featureSetManager = featureSetManager;
  }

  /**
   * Whether a hook is currently executing.
   * Used for loop prevention: inference/request from servers should be rejected
   * while this is true (enforced by Step 6's InferenceRouter).
   */
  get isInHook(): boolean {
    return this._isInHook;
  }

  /**
   * Fan out `context/beforeInference` to all capable MCPL servers in parallel.
   *
   * Returns aggregated ContextInjection[] ready for context-manager's compile().
   * Fail-open: servers that time out or error are silently skipped.
   */
  async beforeInference(params: BeforeInferenceParams): Promise<ContextInjection[]> {
    const servers = this.registry.getServersWithCapability('contextHooks.beforeInference');
    if (servers.length === 0) {
      return [];
    }

    this._isInHook = true;
    try {
      return await this.fanOutBeforeInference(servers, params);
    } finally {
      this._isInHook = false;
    }
  }

  /**
   * Fan out `context/afterInference` to all capable MCPL servers.
   *
   * Non-blocking servers receive a notification (fire-and-forget).
   * Blocking servers receive a request with a 10s timeout.
   * Returns the first valid AfterInferenceResult from a blocking server, or null.
   */
  async afterInference(params: AfterInferenceParams): Promise<AfterInferenceResult | null> {
    const servers = this.registry.getServersWithCapability('contextHooks.afterInference');
    if (servers.length === 0) {
      return null;
    }

    this._isInHook = true;
    try {
      return await this.fanOutAfterInference(servers, params);
    } finally {
      this._isInHook = false;
    }
  }

  // ==========================================================================
  // Private: beforeInference fan-out
  // ==========================================================================

  private async fanOutBeforeInference(
    servers: McplServerConnection[],
    params: BeforeInferenceParams,
  ): Promise<ContextInjection[]> {
    const results = await Promise.allSettled(
      servers.map((server) =>
        withTimeout(
          server.sendBeforeInference(params),
          BEFORE_INFERENCE_TIMEOUT_MS,
          `beforeInference to "${server.id}"`,
        ).then((result) => ({ server, result })),
      ),
    );

    const injections: ContextInjection[] = [];

    for (const settled of results) {
      if (settled.status === 'rejected') {
        // Fail-open: timeout or transport error — skip this server
        continue;
      }

      const { server, result } = settled.value;

      // Validate feature set
      try {
        this.featureSetManager.validateInbound(server.id, result.featureSet);
      } catch {
        // Feature set not enabled or unknown — skip injections from this server
        continue;
      }

      // Convert wire-format injections to context-manager format
      if (result.contextInjections && result.contextInjections.length > 0) {
        for (const mcplInj of result.contextInjections) {
          injections.push(convertMcplInjection(mcplInj));
        }
      }
    }

    return injections;
  }

  // ==========================================================================
  // Private: afterInference fan-out
  // ==========================================================================

  private async fanOutAfterInference(
    servers: McplServerConnection[],
    params: AfterInferenceParams,
  ): Promise<AfterInferenceResult | null> {
    const blockingPromises: Promise<AfterInferenceResult | null>[] = [];

    for (const server of servers) {
      const isBlocking = this.isBlockingAfterInference(server);

      if (isBlocking) {
        // Send as request, await response with timeout
        const promise = withTimeout(
          server.sendAfterInference(params, true) as Promise<AfterInferenceResult>,
          AFTER_INFERENCE_BLOCKING_TIMEOUT_MS,
          `afterInference (blocking) to "${server.id}"`,
        ).catch((): null => {
          // Fail-open: timeout or error — treat as no modification
          return null;
        });
        blockingPromises.push(promise);
      } else {
        // Send as notification (fire-and-forget)
        server.sendAfterInference(params, false);
      }
    }

    if (blockingPromises.length === 0) {
      return null;
    }

    // Await all blocking responses and return the first valid result
    const results = await Promise.all(blockingPromises);
    for (const result of results) {
      if (result && result.modifiedResponse) {
        return result;
      }
    }

    return null;
  }

  /**
   * Check if a server's afterInference capability is blocking.
   */
  private isBlockingAfterInference(server: McplServerConnection): boolean {
    const caps = server.capabilities;
    if (!caps?.contextHooks?.afterInference) {
      return false;
    }
    const afterCap = caps.contextHooks.afterInference;
    return typeof afterCap === 'object' && afterCap !== null && 'blocking' in afterCap && afterCap.blocking === true;
  }
}
