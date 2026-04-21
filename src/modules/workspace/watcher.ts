/**
 * Filesystem watcher with debounce, ignore patterns, and suppression.
 *
 * Events are carried through with their op type (created/modified/deleted) so
 * downstream wake policies can key on creation vs. modification vs. deletion.
 */

import { watch, type FSWatcher } from 'chokidar';
import { type MountConfig } from './types.js';

export type FsOp = 'created' | 'modified' | 'deleted';

export interface FsChange {
  path: string;
  op: FsOp;
}

export interface WatcherEvents {
  onChange(changes: FsChange[]): void;
}

/**
 * Manages filesystem watching for a single mount.
 * Handles debouncing, ignore patterns, and write suppression.
 */
export class MountWatcher {
  private watcher: FSWatcher | null = null;
  // Most recent op seen per path within the current debounce window.
  // create -> modify collapses to 'created' (single batch); delete always wins.
  private pendingChanges = new Map<string, FsOp>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressedPaths = new Set<string>();
  private suppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;
  private readonly config: MountConfig;
  private readonly onChangeCallback: (changes: FsChange[]) => void;

  constructor(
    config: MountConfig,
    onChange: (changes: FsChange[]) => void,
  ) {
    this.config = config;
    this.debounceMs = config.watchDebounceMs ?? 300;
    this.onChangeCallback = onChange;
  }

  /**
   * Start watching the filesystem.
   */
  start(): void {
    if (this.watcher) return;

    const ignored = this.config.ignore ?? [];

    this.watcher = watch(this.config.path, {
      ignored: ignored.length > 0 ? ignored : undefined,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: this.config.followSymlinks ?? false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    const handleEvent = (op: FsOp) => (filePath: string) => {
      const relative = this.toRelative(filePath);
      if (!relative) return;

      // Skip if this path is suppressed (we just wrote it).
      // Suppression covers all ops — a materialize-then-delete by the module
      // should not echo either the add or the unlink.
      if (this.suppressedPaths.has(relative)) return;

      this.mergeOp(relative, op);
      this.scheduleFire();
    };

    this.watcher.on('add', handleEvent('created'));
    this.watcher.on('change', handleEvent('modified'));
    this.watcher.on('unlink', handleEvent('deleted'));
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const timer of this.suppressionTimers.values()) {
      clearTimeout(timer);
    }
    this.suppressionTimers.clear();
    this.suppressedPaths.clear();
    this.pendingChanges.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Suppress watcher events for a path temporarily.
   * Used after materializing to avoid echo events.
   */
  suppress(relativePath: string, cooldownMs = 500): void {
    this.suppressedPaths.add(relativePath);

    const existing = this.suppressionTimers.get(relativePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.suppressedPaths.delete(relativePath);
      this.suppressionTimers.delete(relativePath);
    }, cooldownMs);

    this.suppressionTimers.set(relativePath, timer);
  }

  /**
   * Check if a path is currently suppressed.
   */
  isSuppressed(relativePath: string): boolean {
    return this.suppressedPaths.has(relativePath);
  }

  /**
   * Merge a new op for a path into the pending batch. Chokidar can fire
   * multiple events per path inside one debounce window; collapse them to the
   * single op that reflects the net effect at end-of-window.
   *
   * Transitions (prev → op → result):
   *   ∅          → *         → op
   *   *          → deleted   → deleted        (trailing delete wins)
   *   deleted    → created   → modified       (atomic save: unlink+rename;
   *                                            file exists with new contents)
   *   created    → modified  → created        (still net-new this window)
   *   created    → created   → created
   *   modified   → created   → created        (shouldn't happen, but keep
   *                                            created to avoid a false
   *                                            delete->recreate signal)
   *   modified   → modified  → modified
   */
  private mergeOp(path: string, op: FsOp): void {
    const prev = this.pendingChanges.get(path);
    if (!prev) {
      this.pendingChanges.set(path, op);
      return;
    }
    if (op === 'deleted') {
      this.pendingChanges.set(path, 'deleted');
      return;
    }
    if (prev === 'deleted' && op === 'created') {
      this.pendingChanges.set(path, 'modified');
      return;
    }
    if (prev === 'created') {
      this.pendingChanges.set(path, 'created');
      return;
    }
    this.pendingChanges.set(path, op);
  }

  private scheduleFire(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.pendingChanges.size > 0) {
        const changes: FsChange[] = [...this.pendingChanges].map(([path, op]) => ({ path, op }));
        this.pendingChanges.clear();
        this.onChangeCallback(changes);
      }
    }, this.debounceMs);
  }

  private toRelative(absolutePath: string): string | null {
    const base = this.config.path.endsWith('/')
      ? this.config.path
      : this.config.path + '/';
    if (absolutePath.startsWith(base)) {
      return absolutePath.slice(base.length);
    }
    return null;
  }
}
