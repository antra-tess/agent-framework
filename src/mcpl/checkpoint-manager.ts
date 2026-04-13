/**
 * CheckpointManager — MCPL state management with branching checkpoint trees.
 *
 * Manages per-(serverId, featureSet) checkpoint trees for stateful MCPL tools.
 * Two modes:
 *   - hostState: true  → host stores state data, applies JSON Patch deltas
 *   - hostState: false → host tracks opaque checkpoint IDs only
 *
 * Checkpoint tree metadata is persisted to Chronicle via a `mcpl/checkpoints`
 * state slot. Host-managed state data is persisted per feature set.
 *
 * Spec reference: Section 8 (State Management).
 */

import type { JsStore } from '@animalabs/chronicle';

import type { StateCheckpoint, JsonPatchOperation } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Chronicle state ID for checkpoint tree metadata. */
const CHECKPOINTS_STATE_ID = 'mcpl/checkpoints';

/** Prefix for per-feature-set host-managed state. */
const STATE_PREFIX = 'mcpl/state';

// ============================================================================
// Internal types
// ============================================================================

interface CheckpointNode {
  checkpoint: string;
  parent: string | null;
  children: string[];
  /** Full state data snapshot (host-managed, when server sends `data`). */
  data?: unknown;
  /** JSON Patch delta from parent (host-managed, when server sends `patch`). */
  patch?: JsonPatchOperation[];
}

interface FeatureSetState {
  hostState: boolean;
  rollback: boolean;
  currentCheckpoint: string | null;
  /** Reconstructed state at currentCheckpoint (host-managed only). */
  currentState: unknown | undefined;
  nodes: Map<string, CheckpointNode>;
}

/** Serialized form stored in Chronicle. */
interface SerializedTrees {
  trees: Record<string, {
    hostState: boolean;
    rollback: boolean;
    current: string | null;
    nodes: Record<string, { parent: string | null; children: string[]; data?: unknown; patch?: JsonPatchOperation[] }>;
  }>;
}

// ============================================================================
// JSON Patch (RFC 6902) — minimal implementation
// ============================================================================

/**
 * Parse a JSON Pointer (RFC 6901) into path segments.
 * E.g. "/foo/0/bar" → ["foo", "0", "bar"]
 */
function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid JSON Pointer: ${pointer}`);
  }
  return pointer.slice(1).split('/').map(
    (s) => s.replace(/~1/g, '/').replace(/~0/g, '~'),
  );
}

/**
 * Navigate to a parent container and return [parent, lastKey].
 * Throws if the path doesn't exist.
 */
function navigateTo(
  doc: unknown,
  segments: string[],
): [parent: Record<string, unknown> | unknown[], key: string] {
  let current: unknown = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (Array.isArray(current)) {
      current = current[Number(seg)];
    } else if (current !== null && typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
    } else {
      throw new Error(`Cannot navigate path segment "${seg}": not an object/array`);
    }
  }
  return [current as Record<string, unknown> | unknown[], segments[segments.length - 1]!];
}

/**
 * Apply a JSON Patch (RFC 6902) to a document.
 * Supports: add, remove, replace, test.
 * Operates on a deep-cloned document to avoid mutation.
 */
export function applyJsonPatch(doc: unknown, ops: JsonPatchOperation[]): unknown {
  let result: unknown = structuredClone(doc);

  for (const op of ops) {
    const segments = parsePointer(op.path);

    switch (op.op) {
      case 'add': {
        if (segments.length === 0) {
          result = op.value;
          break;
        }
        const [parent, key] = navigateTo(result, segments);
        if (Array.isArray(parent)) {
          const idx = key === '-' ? parent.length : Number(key);
          parent.splice(idx, 0, op.value);
        } else {
          (parent as Record<string, unknown>)[key] = op.value;
        }
        break;
      }

      case 'remove': {
        const [parent, key] = navigateTo(result, segments);
        if (Array.isArray(parent)) {
          parent.splice(Number(key), 1);
        } else {
          delete (parent as Record<string, unknown>)[key];
        }
        break;
      }

      case 'replace': {
        if (segments.length === 0) {
          result = op.value;
          break;
        }
        const [parent, key] = navigateTo(result, segments);
        if (Array.isArray(parent)) {
          parent[Number(key)] = op.value;
        } else {
          (parent as Record<string, unknown>)[key] = op.value;
        }
        break;
      }

      case 'test': {
        const [parent, key] = navigateTo(result, segments);
        const actual = Array.isArray(parent)
          ? parent[Number(key)]
          : (parent as Record<string, unknown>)[key];
        if (JSON.stringify(actual) !== JSON.stringify(op.value)) {
          throw new Error(
            `JSON Patch test failed at "${op.path}": expected ${JSON.stringify(op.value)}, got ${JSON.stringify(actual)}`,
          );
        }
        break;
      }

      case 'move':
      case 'copy':
        // Deferred — not needed for MVP
        throw new Error(`JSON Patch op "${op.op}" not yet supported`);
    }
  }

  return result;
}

// ============================================================================
// CheckpointManager
// ============================================================================

export class CheckpointManager {
  private store: JsStore;
  private emitTraceFn: (event: { type: string; [key: string]: unknown }) => void;
  private trees = new Map<string, FeatureSetState>();

  constructor(
    store: JsStore,
    emitTraceFn: (event: { type: string; [key: string]: unknown }) => void,
  ) {
    this.store = store;
    this.emitTraceFn = emitTraceFn;

    // Register the checkpoint metadata state slot
    try {
      store.registerState({ id: CHECKPOINTS_STATE_ID, strategy: 'snapshot' });
    } catch {
      // Already registered (e.g. framework restart)
    }

    // Load existing tree from Chronicle
    this.loadFromStore();
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  /**
   * Register a feature set as stateful.
   * Called during initializeMcpl for feature sets with rollback or hostState.
   */
  registerFeatureSet(
    serverId: string,
    featureSet: string,
    opts: { hostState: boolean; rollback: boolean },
  ): void {
    const key = this.key(serverId, featureSet);
    if (this.trees.has(key)) return; // Already registered (e.g. from loaded state)

    this.trees.set(key, {
      hostState: opts.hostState,
      rollback: opts.rollback,
      currentCheckpoint: null,
      currentState: undefined,
      nodes: new Map(),
    });

    // Register per-feature-set state slot for host-managed state
    if (opts.hostState) {
      const stateId = this.stateId(serverId, featureSet);
      try {
        this.store.registerState({ id: stateId, strategy: 'snapshot' });
      } catch {
        // Already registered
      }
      // Load existing state if any
      const existing = this.store.getStateJson(stateId);
      if (existing !== null && existing !== undefined) {
        const tree = this.trees.get(key)!;
        tree.currentState = existing;
      }
    }

    this.emitTraceFn({
      type: 'mcpl:state_registered',
      serverId,
      featureSet,
      hostState: opts.hostState,
      rollback: opts.rollback,
    });

    this.persistTree();
  }

  // ==========================================================================
  // Checkpoint recording
  // ==========================================================================

  /**
   * Record a checkpoint returned in a tool call response.
   * Updates the tree and persists to Chronicle.
   */
  recordCheckpoint(
    serverId: string,
    featureSet: string,
    checkpoint: StateCheckpoint,
  ): void {
    const key = this.key(serverId, featureSet);
    const tree = this.trees.get(key);
    if (!tree) return;

    // Add node to tree
    const node: CheckpointNode = {
      checkpoint: checkpoint.checkpoint,
      parent: checkpoint.parent,
      children: [],
      data: checkpoint.data,
      patch: checkpoint.patch,
    };

    // Link to parent
    if (checkpoint.parent) {
      const parentNode = tree.nodes.get(checkpoint.parent);
      if (parentNode) {
        parentNode.children.push(checkpoint.checkpoint);
      }
    }

    tree.nodes.set(checkpoint.checkpoint, node);
    tree.currentCheckpoint = checkpoint.checkpoint;

    // For host-managed state, reconstruct current state
    if (tree.hostState) {
      if (checkpoint.data !== undefined) {
        // Full state provided — use directly
        tree.currentState = structuredClone(checkpoint.data);
      } else if (checkpoint.patch) {
        // Delta provided — apply to current state
        try {
          tree.currentState = applyJsonPatch(
            tree.currentState ?? {},
            checkpoint.patch,
          );
        } catch (err) {
          console.error(
            `[CheckpointManager] JSON Patch failed for ${key}:`,
            err instanceof Error ? err.message : err,
          );
          // Keep existing state on patch failure
        }
      }

      // Persist reconstructed state
      this.store.setStateJson(this.stateId(serverId, featureSet), tree.currentState);
    }

    this.emitTraceFn({
      type: 'mcpl:checkpoint_recorded',
      serverId,
      featureSet,
      checkpoint: checkpoint.checkpoint,
      parent: checkpoint.parent,
      hasData: checkpoint.data !== undefined,
      hasPatch: checkpoint.patch !== undefined,
    });

    this.persistTree();
  }

  // ==========================================================================
  // State access (for tools/call params)
  // ==========================================================================

  /** Get current reconstructed state for host-managed feature sets. */
  getCurrentState(serverId: string, featureSet: string): unknown | undefined {
    return this.trees.get(this.key(serverId, featureSet))?.currentState;
  }

  /** Get current checkpoint ID for server-managed feature sets. */
  getCurrentCheckpoint(serverId: string, featureSet: string): string | null {
    return this.trees.get(this.key(serverId, featureSet))?.currentCheckpoint ?? null;
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  /** Check if a (serverId, featureSet) pair is registered as stateful. */
  isStateful(serverId: string, featureSet: string): boolean {
    return this.trees.has(this.key(serverId, featureSet));
  }

  /** Check if a (serverId, featureSet) pair uses host-managed state. */
  isHostManaged(serverId: string, featureSet: string): boolean {
    return this.trees.get(this.key(serverId, featureSet))?.hostState ?? false;
  }

  /**
   * Get the first stateful feature set for a given server.
   * Returns null if no stateful feature sets are registered.
   */
  getStatefulFeatureSet(serverId: string): string | null {
    const prefix = `${serverId}:`;
    for (const [key] of this.trees) {
      if (key.startsWith(prefix)) {
        return key.slice(prefix.length);
      }
    }
    return null;
  }

  // ==========================================================================
  // Rollback
  // ==========================================================================

  /**
   * Roll back to a previous checkpoint in the tree.
   * Updates the current pointer and, for host-managed state, reconstructs
   * the state at that checkpoint.
   *
   * Returns the reconstructed state (host-managed) or undefined (server-managed).
   * Throws if the checkpoint is not found.
   */
  rollbackTo(
    serverId: string,
    featureSet: string,
    checkpoint: string,
  ): unknown | undefined {
    const key = this.key(serverId, featureSet);
    const tree = this.trees.get(key);
    if (!tree) throw new Error(`No stateful feature set: ${key}`);

    const node = tree.nodes.get(checkpoint);
    if (!node) throw new Error(`Checkpoint not found: ${checkpoint}`);

    tree.currentCheckpoint = checkpoint;

    if (tree.hostState) {
      // Reconstruct state at this checkpoint by walking from root
      tree.currentState = this.reconstructState(tree, checkpoint);
      this.store.setStateJson(this.stateId(serverId, featureSet), tree.currentState);
    }

    this.emitTraceFn({
      type: 'mcpl:state_rollback',
      serverId,
      featureSet,
      checkpoint,
    });

    this.persistTree();
    return tree.currentState;
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /** Remove all state for a server (called on disconnect). */
  removeServer(serverId: string): void {
    const prefix = `${serverId}:`;
    const toRemove: string[] = [];

    for (const [key] of this.trees) {
      if (key.startsWith(prefix)) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.trees.delete(key);
    }

    if (toRemove.length > 0) {
      this.persistTree();
    }
  }

  // ==========================================================================
  // Private: State reconstruction
  // ==========================================================================

  /**
   * Reconstruct host-managed state at a given checkpoint by walking
   * from the nearest ancestor with full data down to the target.
   */
  private reconstructState(tree: FeatureSetState, checkpoint: string): unknown {
    // Build path from root to checkpoint
    const path: CheckpointNode[] = [];
    let current: string | null = checkpoint;

    while (current !== null) {
      const node = tree.nodes.get(current);
      if (!node) break;
      path.unshift(node);
      current = node.parent;
    }

    // Walk forward, applying data/patches
    let state: unknown = {};

    for (const node of path) {
      if (node.data !== undefined) {
        // Full state snapshot — use it, discard prior state
        state = structuredClone(node.data);
      } else if (node.patch) {
        // Delta — apply to current state
        try {
          state = applyJsonPatch(state, node.patch);
        } catch {
          // On patch failure, keep last known good state
        }
      }
    }

    return state;
  }

  // ==========================================================================
  // Private: Persistence
  // ==========================================================================

  /** Persist checkpoint tree metadata to Chronicle. */
  private persistTree(): void {
    const serialized: SerializedTrees = { trees: {} };

    for (const [key, tree] of this.trees) {
      const nodes: SerializedTrees['trees'][string]['nodes'] = {};
      for (const [id, node] of tree.nodes) {
        nodes[id] = {
          parent: node.parent,
          children: node.children,
          data: node.data,
          patch: node.patch,
        };
      }
      serialized.trees[key] = {
        hostState: tree.hostState,
        rollback: tree.rollback,
        current: tree.currentCheckpoint,
        nodes,
      };
    }

    this.store.setStateJson(CHECKPOINTS_STATE_ID, serialized);
  }

  /** Load checkpoint tree from Chronicle on startup. */
  private loadFromStore(): void {
    const data = this.store.getStateJson(CHECKPOINTS_STATE_ID) as SerializedTrees | null;
    if (!data?.trees) return;

    for (const [key, entry] of Object.entries(data.trees)) {
      const nodes = new Map<string, CheckpointNode>();
      for (const [id, nodeData] of Object.entries(entry.nodes)) {
        nodes.set(id, {
          checkpoint: id,
          parent: nodeData.parent,
          children: [...nodeData.children],
          data: nodeData.data,
          patch: nodeData.patch,
        });
      }

      this.trees.set(key, {
        hostState: entry.hostState,
        rollback: entry.rollback,
        currentCheckpoint: entry.current,
        currentState: undefined, // Will be loaded per-feature-set during registerFeatureSet
        nodes,
      });
    }
  }

  // ==========================================================================
  // Private: Helpers
  // ==========================================================================

  private key(serverId: string, featureSet: string): string {
    return `${serverId}:${featureSet}`;
  }

  private stateId(serverId: string, featureSet: string): string {
    return `${STATE_PREFIX}/${serverId}/${featureSet}`;
  }
}
