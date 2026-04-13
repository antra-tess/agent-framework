/**
 * InferenceRouter — handles inference/request from MCPL servers.
 *
 * Servers can ask the host to run inference on their behalf. This router
 * validates permissions, resolves the target model via routing policy,
 * runs inference through membrane, and optionally streams chunks back.
 *
 * Spec reference: Section 11 (Server-Initiated Inference).
 */

import type { Membrane, ContentBlock, NormalizedRequest } from '@animalabs/membrane';

import type {
  McplInferenceRequestParams,
  McplInferenceRequestResult,
  InferenceChunkParams,
  InferenceRoutingPolicy,
} from './types.js';
import type { FeatureSetManager } from './feature-set-manager.js';
import { McplFeatureSetError } from './feature-set-manager.js';
import type { HookOrchestrator } from './hook-orchestrator.js';

// ============================================================================
// Responder interface
// ============================================================================

/** Minimal responder interface for sending JSON-RPC results back. */
interface Responder {
  respond(result: McplInferenceRequestResult): void;
  respondError(code: number, message: string, data?: unknown): void;
  /** The JSON-RPC request ID, used for streaming chunk correlation. */
  requestId?: string | number;
}

// ============================================================================
// Wildcard matching (same logic as feature-set-manager)
// ============================================================================

/**
 * Simple glob match: split on `.`, `*` matches any single segment.
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
      continue;
    }
    if (p !== nameParts[i]) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// Constants
// ============================================================================

/** Default max tokens when not specified in preferences. */
const DEFAULT_MAX_TOKENS = 4096;

// ============================================================================
// InferenceRouter
// ============================================================================

export class InferenceRouter {
  private membrane: Membrane;
  private hookOrchestrator: HookOrchestrator;
  private featureSetManager: FeatureSetManager;
  private routingPolicy: InferenceRoutingPolicy | null;
  private emitTraceFn: (event: { type: string; [key: string]: unknown }) => void;
  private sendChunkFn?: (serverId: string, params: InferenceChunkParams) => void;

  constructor(
    membrane: Membrane,
    hookOrchestrator: HookOrchestrator,
    featureSetManager: FeatureSetManager,
    routingPolicy: InferenceRoutingPolicy | null,
    emitTraceFn: (event: { type: string; [key: string]: unknown }) => void,
    sendChunkFn?: (serverId: string, params: InferenceChunkParams) => void,
  ) {
    this.membrane = membrane;
    this.hookOrchestrator = hookOrchestrator;
    this.featureSetManager = featureSetManager;
    this.routingPolicy = routingPolicy;
    this.emitTraceFn = emitTraceFn;
    this.sendChunkFn = sendChunkFn;
  }

  /**
   * Handle an inference/request from an MCPL server.
   *
   * 1. Validate feature set
   * 2. Check loop prevention (reject if inside a hook)
   * 3. Resolve model from routing policy
   * 4. Build membrane request and run inference
   * 5. Optionally stream chunks
   * 6. Return result via responder
   */
  async handleInferenceRequest(
    serverId: string,
    params: McplInferenceRequestParams,
    responder: Responder,
  ): Promise<void> {
    // 1. Validate feature set
    try {
      this.featureSetManager.validateInbound(serverId, params.featureSet);
    } catch (err) {
      const message = err instanceof McplFeatureSetError
        ? err.message
        : 'Feature set validation failed';
      const code = err instanceof McplFeatureSetError ? err.code : -32600;
      responder.respondError(code, message);
      return;
    }

    // 2. Loop prevention: reject if inside a hook
    if (this.hookOrchestrator.isInHook) {
      responder.respondError(
        -32600,
        'Cannot process inference request during hook execution',
      );
      return;
    }

    // 3. Resolve model
    const model = this.resolveModel(
      params.featureSet,
      params.conversationId,
    );

    // Emit trace: inference start
    this.emitTraceFn({
      type: 'mcpl:inference_start',
      serverId,
      featureSet: params.featureSet,
      model,
      stream: params.stream ?? false,
    });

    // 4. Build membrane-compatible request
    const messages: NormalizedRequest['messages'] = params.messages.map((msg) => ({
      participant: msg.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text' as const, text: msg.content }],
    }));

    const request: NormalizedRequest = {
      messages,
      config: {
        model,
        maxTokens: params.preferences?.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: params.preferences?.temperature,
      },
    };

    try {
      // 5. Run inference
      if (params.stream && this.sendChunkFn && responder.requestId != null) {
        // Streaming mode
        await this.handleStreaming(serverId, model, request, responder);
      } else {
        // Non-streaming mode
        const response = await this.membrane.complete(request);

        // Extract text content from response
        const contentText = response.content
          .filter((b: ContentBlock): b is ContentBlock & { type: 'text' } => b.type === 'text')
          .map((b: ContentBlock & { type: 'text' }) => b.text)
          .join('');

        const result: McplInferenceRequestResult = {
          content: contentText,
          model,
          finishReason: this.mapStopReason(response.stopReason),
          usage: {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
          },
        };

        // Emit trace: inference complete
        this.emitTraceFn({
          type: 'mcpl:inference_complete',
          serverId,
          model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });

        responder.respond(result);
      }
    } catch (err) {
      // Emit trace: inference failed
      this.emitTraceFn({
        type: 'mcpl:inference_fail',
        serverId,
        model,
        error: err instanceof Error ? err.message : String(err),
      });

      responder.respondError(
        -32603,
        err instanceof Error ? err.message : 'Inference failed',
      );
    }
  }

  // ==========================================================================
  // Private: Model resolution
  // ==========================================================================

  /**
   * Resolve the model to use for an inference request based on routing policy.
   *
   * Priority:
   * 1. Per-conversation override
   * 2. Exact feature set match
   * 3. Wildcard pattern match (first match wins)
   * 4. Default from policy
   * 5. Fallback string 'default'
   */
  private resolveModel(
    featureSet: string,
    conversationId?: string,
  ): string {
    if (!this.routingPolicy) {
      return 'default';
    }

    // Check per-conversation override
    if (conversationId && this.routingPolicy.overrides?.[conversationId]) {
      return this.routingPolicy.overrides[conversationId];
    }

    // Check exact feature set match
    if (this.routingPolicy.byFeature?.[featureSet]) {
      return this.routingPolicy.byFeature[featureSet];
    }

    // Check wildcard patterns
    if (this.routingPolicy.wildcards) {
      for (const [pattern, matchedModel] of Object.entries(this.routingPolicy.wildcards)) {
        if (wildcardMatch(pattern, featureSet)) {
          return matchedModel;
        }
      }
    }

    // Default
    return this.routingPolicy.default;
  }

  // ==========================================================================
  // Private: Streaming
  // ==========================================================================

  /**
   * Handle streaming inference by sending chunks back to the server.
   *
   * Uses membrane.streamYielding when available; falls back to non-streaming
   * membrane.complete otherwise.
   */
  private async handleStreaming(
    serverId: string,
    model: string,
    request: NormalizedRequest,
    responder: Responder,
  ): Promise<void> {
    const requestId = responder.requestId!;

    // Check if streamYielding is available on the membrane instance.
    // We use streamYielding to iterate events and forward text deltas as chunks.
    const stream = this.membrane.streamYielding(request);
    let chunkIndex = 0;
    let fullContent = '';

    for await (const event of stream) {
      if (event.type === 'tokens' && 'content' in event) {
        const delta = (event as { type: 'tokens'; content: string }).content;
        fullContent += delta;
        this.sendChunkFn!(serverId, {
          requestId,
          index: chunkIndex++,
          delta,
        });
      }
    }

    // After streaming completes, send the final result
    const result: McplInferenceRequestResult = {
      content: fullContent,
      model,
      finishReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    this.emitTraceFn({
      type: 'mcpl:inference_complete',
      serverId,
      model,
      streamed: true,
    });

    responder.respond(result);
  }

  // ==========================================================================
  // Private: Helpers
  // ==========================================================================

  /**
   * Map membrane's stopReason string to MCPL's finishReason enum.
   */
  private mapStopReason(
    stopReason: string | undefined,
  ): 'end_turn' | 'max_tokens' | 'stop_sequence' {
    switch (stopReason) {
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      case 'end_turn':
      default:
        return 'end_turn';
    }
  }
}
