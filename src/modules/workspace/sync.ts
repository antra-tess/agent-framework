/**
 * Sync logic between filesystem and Chronicle tree state.
 *
 * Two directions:
 * - syncFromFs: filesystem → Chronicle (user changes)
 * - materializeToFs: Chronicle → filesystem (agent changes)
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import type { JsStore, JsTreeEntry } from '@animalabs/chronicle';
import type { MountState } from './types.js';

export const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Resolve a relative path within a mount and verify it doesn't escape.
 * Returns the absolute path, or null if the path is outside the mount.
 */
function safePath(mountPath: string, relativePath: string): string | null {
  const resolved = resolve(mountPath, relativePath);
  const root = mountPath.endsWith('/') ? mountPath : mountPath + '/';
  if (resolved !== mountPath && !resolved.startsWith(root)) {
    return null;
  }
  return resolved;
}

/**
 * Hash file content to a full SHA-256 hex string.
 * Must match Chronicle's storeBlob() hash format (64-char hex).
 */
export function hashContent(content: string | Buffer): string {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

/**
 * Check if content appears to be binary.
 */
function isBinary(buffer: Buffer): boolean {
  // Check for null bytes in first 8KB
  const check = buffer.subarray(0, 8192);
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true;
  }
  return false;
}

export interface ConflictInfo {
  /** Relative path of the conflicted file */
  path: string;
  /** Blob hash of the agent's version (retrievable via store.getBlob()) */
  agentBlobHash: string;
}

export interface SyncResult {
  /** Paths that were synced */
  synced: string[];
  /** Paths that conflicted (both agent and user modified) — filesystem wins */
  conflicts: ConflictInfo[];
  /** Paths that were skipped (binary, too large, etc.) */
  skipped: string[];
}

/**
 * Sync filesystem changes into Chronicle tree state.
 *
 * @param store Chronicle store
 * @param mount Mount state
 * @param paths Specific paths to sync (relative to mount). If empty, walks the directory.
 * @returns Sync result with synced/conflicted/skipped paths
 */
export async function syncFromFs(
  store: JsStore,
  mount: MountState,
  paths?: string[],
): Promise<SyncResult> {
  const result: SyncResult = { synced: [], conflicts: [], skipped: [] };
  const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  const filesToSync = paths ?? await walkDirectory(mount.config.path, mount.config.ignore ?? []);

  for (const relativePath of filesToSync) {
    const absolutePath = safePath(mount.config.path, relativePath);
    if (!absolutePath) {
      result.skipped.push(relativePath);
      continue;
    }

    try {
      await access(absolutePath);
    } catch {
      // File was deleted on disk — remove from tree
      const existing = store.treeGet(mount.treeStateId, relativePath);
      if (existing) {
        store.treeRemove(mount.treeStateId, relativePath);
        result.synced.push(relativePath);
      }
      continue;
    }

    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) continue;
      if (fileStat.size > maxSize) {
        result.skipped.push(relativePath);
        continue;
      }

      const buffer = await readFile(absolutePath);
      if (isBinary(buffer)) {
        result.skipped.push(relativePath);
        continue;
      }

      const content = buffer.toString('utf-8');
      const hash = hashContent(content);

      // Check current tree state
      const existing = store.treeGet(mount.treeStateId, relativePath);

      if (existing && existing.blobHash === hash) {
        // No change
        continue;
      }

      // Store blob and update tree
      const blobHash = store.storeBlob(Buffer.from(content, 'utf-8'), 'text/plain');
      const entry: JsTreeEntry = {
        blobHash,
        size: buffer.length,
        mode: 0o644,
      };

      // Conflict detection: if the file existed in the tree AND the agent has
      // modified it since last materialization, this is a genuine conflict
      // (both agent and user changed the same file).
      if (existing) {
        const baselineHash = mount.materializedHashes.get(relativePath);
        if (baselineHash && existing.blobHash !== baselineHash) {
          // Agent changed the tree entry since we last materialized — conflict.
          // Filesystem still wins, but agent's version is recoverable via agentBlobHash.
          result.conflicts.push({
            path: relativePath,
            agentBlobHash: existing.blobHash,
          });
        }
      }

      store.treeSet(mount.treeStateId, relativePath, entry);
      result.synced.push(relativePath);
    } catch {
      result.skipped.push(relativePath);
    }
  }

  return result;
}

/**
 * Materialize Chronicle tree state to filesystem.
 *
 * @param store Chronicle store
 * @param mount Mount state
 * @param paths Specific paths to materialize. If undefined, materializes all changed since last.
 * @returns List of paths that were written
 */
export async function materializeToFs(
  store: JsStore,
  mount: MountState,
  paths?: string[],
): Promise<string[]> {
  if (mount.config.mode === 'read-only') {
    return [];
  }

  const written: string[] = [];

  // Get changed files since last materialization
  const currentSeq = store.currentSequence();
  let filesToMaterialize: Array<{ path: string; blobHash: string }>;

  if (paths) {
    // Materialize specific paths
    filesToMaterialize = [];
    for (const p of paths) {
      const entry = store.treeGet(mount.treeStateId, p);
      if (entry) {
        filesToMaterialize.push({ path: p, blobHash: entry.blobHash });
      }
    }
  } else if (mount.lastMaterializedSeq > 0) {
    // Diff since last materialization
    const changes = store.treeDiff(
      mount.treeStateId,
      mount.lastMaterializedSeq,
      currentSeq,
    );
    filesToMaterialize = changes
      .filter(c => c.changeType === 'added' || c.changeType === 'modified')
      .map(c => ({
        path: c.path,
        blobHash: c.newEntry!.blobHash,
      }));

    // Handle removals
    for (const change of changes) {
      if (change.changeType === 'removed') {
        // Don't delete from filesystem — just skip.
        // Agent removing from tree doesn't mean delete user's file.
      }
    }
  } else {
    // First materialization — materialize everything
    const entries = store.treeList(mount.treeStateId);
    filesToMaterialize = entries.map(e => ({
      path: e.path,
      blobHash: e.blobHash,
    }));
  }

  for (const { path: relativePath, blobHash } of filesToMaterialize) {
    const absolutePath = safePath(mount.config.path, relativePath);
    if (!absolutePath) continue; // Path traversal — skip silently

    const blob = store.getBlob(blobHash);
    if (!blob) continue;

    // Create parent directories
    await mkdir(dirname(absolutePath), { recursive: true });

    // Write file
    await writeFile(absolutePath, blob);
    written.push(relativePath);

    // Record blob hash at materialization time for conflict detection
    mount.materializedHashes.set(relativePath, blobHash);
  }

  mount.lastMaterializedSeq = currentSeq;

  return written;
}

/**
 * Walk a directory recursively, respecting ignore patterns.
 */
async function walkDirectory(
  basePath: string,
  ignorePatterns: string[],
): Promise<string[]> {
  const results: string[] = [];
  const maxFiles = 5000; // Safety limit

  async function walk(dir: string) {
    if (results.length >= maxFiles) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;

      const fullPath = join(dir, entry.name);
      const relativePath = relative(basePath, fullPath);

      // Check ignore patterns (simple glob matching)
      if (shouldIgnore(relativePath, entry.name, ignorePatterns)) continue;

      if (entry.isFile()) {
        results.push(relativePath);
      } else if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(basePath);
  return results;
}

/**
 * Simple ignore pattern matching.
 */
function shouldIgnore(
  relativePath: string,
  name: string,
  patterns: string[],
): boolean {
  for (const pattern of patterns) {
    // Exact name match (e.g., ".git", "node_modules")
    if (pattern === name) return true;

    // Simple ** glob: "node_modules/**" matches anything under node_modules
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      if (relativePath.startsWith(prefix + '/') || relativePath === prefix) return true;
    }

    // Extension glob: "*.pyc" matches any .pyc file
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1);
      if (name.endsWith(ext)) return true;
    }
  }
  return false;
}
