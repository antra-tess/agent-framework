/**
 * PushHandler — handles push/event messages from MCPL servers.
 *
 * Validates feature sets, deduplicates by eventId, converts MCPL content blocks
 * to membrane ContentBlock[], and pushes McplPushEvents into the processing queue.
 *
 * Spec reference: Section 9 (Push Events).
 */

import type { ContentBlock } from 'membrane';

import type {
  McplContentBlock,
  PushEventParams,
  PushEventResult,
} from './types.js';
import type { FeatureSetManager } from './feature-set-manager.js';
import { McplFeatureSetError } from './feature-set-manager.js';

// ============================================================================
// McplPushEvent (the ProcessEvent shape pushed to the queue)
// ============================================================================

/**
 * A push event converted for the framework processing queue.
 *
 * NOTE: This interface should be added to src/types/events.ts and included
 * in the ProcessEvent union. It is defined here for reference but the actual
 * events.ts modification is deferred.
 */
export interface McplPushEvent {
  type: 'mcpl:push-event';
  serverId: string;
  featureSet: string;
  eventId: string;
  content: ContentBlock[];
  origin?: Record<string, unknown>;
  timestamp: string;
  inferenceId: string;
  triggerInference?: boolean;
  targetAgents?: string[];
}

// ============================================================================
// Content conversion: McplContentBlock → membrane ContentBlock
// ============================================================================

/**
 * Convert a single MCPL wire-format content block to a membrane ContentBlock.
 * Same logic as hook-orchestrator.ts.
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
        } as ContentBlock;
      }
      if (block.uri) {
        return {
          type: 'image',
          source: { type: 'url', url: block.uri },
        } as ContentBlock;
      }
      return { type: 'text', text: '[Image: no data]' };

    case 'audio':
      if (block.data && block.mimeType) {
        return {
          type: 'audio',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        } as ContentBlock;
      }
      return { type: 'text', text: '[Audio: no data]' };

    case 'resource':
      return { type: 'text', text: `[Resource: ${block.uri}]` };
  }
}

// ============================================================================
// LRU Dedup Set
// ============================================================================

/**
 * Simple dedup set with a max capacity. When full, clears and starts fresh.
 * Good enough for a deduplication window — exact LRU is overkill here.
 */
class DedupSet {
  private set = new Set<string>();
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Returns true if the key was already present (duplicate).
   * Otherwise adds it and returns false.
   */
  checkAndAdd(key: string): boolean {
    if (this.set.has(key)) {
      return true;
    }
    if (this.set.size >= this.maxSize) {
      this.set.clear();
    }
    this.set.add(key);
    return false;
  }
}

// ============================================================================
// Responder interface
// ============================================================================

/** Minimal responder interface for sending JSON-RPC results back. */
interface Responder {
  respond(result: PushEventResult): void;
  respondError?(code: number, message: string, data?: unknown): void;
}

// ============================================================================
// PushHandler
// ============================================================================

export class PushHandler {
  private featureSetManager: FeatureSetManager;
  private pushEventFn: (event: McplPushEvent) => void;
  private emitTraceFn: (event: { type: string; [key: string]: unknown }) => void;
  private shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean;
  private dedup = new DedupSet(1000);

  constructor(
    featureSetManager: FeatureSetManager,
    pushEventFn: (event: McplPushEvent) => void,
    emitTraceFn: (event: { type: string; [key: string]: unknown }) => void,
    shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean,
  ) {
    this.featureSetManager = featureSetManager;
    this.pushEventFn = pushEventFn;
    this.emitTraceFn = emitTraceFn;
    this.shouldTriggerInference = shouldTriggerInference;
  }

  /**
   * Handle a push/event message from an MCPL server.
   *
   * 1. Validate feature set
   * 2. Deduplicate by eventId
   * 3. Optionally check shouldTriggerInference callback
   * 4. Convert content blocks
   * 5. Push event to queue
   * 6. Emit trace
   * 7. Respond with accepted + inferenceId
   */
  handlePushEvent(
    serverId: string,
    params: PushEventParams,
    responder?: Responder,
  ): void {
    // 1. Validate feature set
    try {
      this.featureSetManager.validateInbound(serverId, params.featureSet);
    } catch (err) {
      const reason = err instanceof McplFeatureSetError
        ? err.message
        : 'Feature set validation failed';
      responder?.respond({ accepted: false, reason });
      return;
    }

    // 2. Deduplicate by eventId
    if (this.dedup.checkAndAdd(params.eventId)) {
      responder?.respond({ accepted: false, reason: 'duplicate' });
      return;
    }

    // 3. Convert content blocks
    const content: ContentBlock[] = params.payload.content.map(convertBlock);

    // 4. Check shouldTriggerInference callback
    let triggerInference = true;
    if (this.shouldTriggerInference) {
      const textContent = content
        .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const metadata: Record<string, unknown> = {
        serverId,
        featureSet: params.featureSet,
        eventId: params.eventId,
        eventType: 'push:event',
        ...(params.origin ?? {}),
      };
      triggerInference = this.shouldTriggerInference(textContent, metadata);
    }

    // 5. Generate inferenceId
    const inferenceId = `${serverId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // 6. Push event to queue
    const pushEvent: McplPushEvent = {
      type: 'mcpl:push-event',
      serverId,
      featureSet: params.featureSet,
      eventId: params.eventId,
      content,
      origin: params.origin,
      timestamp: params.timestamp,
      inferenceId,
      triggerInference,
    };
    this.pushEventFn(pushEvent);

    // 7. Emit trace
    this.emitTraceFn({
      type: 'mcpl:push_event',
      serverId,
      eventId: params.eventId,
      featureSet: params.featureSet,
    });

    // 8. Respond
    responder?.respond({ accepted: true, inferenceId });
  }
}
