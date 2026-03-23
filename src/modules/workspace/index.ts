/**
 * WorkspaceModule — mountable filesystem abstraction backed by Chronicle tree state.
 *
 * Provides a unified workspace with mount-based filesystem access,
 * auto-sync between real filesystem and Chronicle, and manual materialization.
 */

import { createHash } from 'node:crypto';
import { readFile, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsStore } from 'chronicle';
import type { Module, ModuleContext, ProcessState, EventResponse } from '../../types/module.js';
import type { ProcessEvent, ToolDefinition, ToolCall, ToolResult } from '../../types/events.js';
import type {
  WorkspaceConfig,
  MountConfig,
  MountState,
  WorkspaceModuleState,
  ReadInput,
  WriteInput,
  EditInput,
  DeleteInput,
  LsInput,
  GlobInput,
  GrepInput,
  StatusInput,
  MaterializeInput,
  SyncInput,
  WorkspaceChangedEvent,
} from './types.js';
import { MountWatcher } from './watcher.js';
import { syncFromFs, materializeToFs, hashContent } from './sync.js';

export type {
  WorkspaceConfig,
  MountConfig,
  MountState,
  WorkspaceModuleState,
  ReadInput,
  WriteInput,
  EditInput,
  DeleteInput,
  LsInput,
  GlobInput,
  GrepInput,
  StatusInput,
  MaterializeInput,
  SyncInput,
} from './types.js';

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;

export class WorkspaceModule implements Module {
  readonly name = 'workspace';

  private ctx: ModuleContext | null = null;
  private store: JsStore | null = null;
  private config: WorkspaceConfig;
  private mounts = new Map<string, MountState>();
  private watchers = new Map<string, MountWatcher>();

  constructor(config: WorkspaceConfig) {
    this.config = config;
  }

  /**
   * Inject the Chronicle store. Must be called after framework creation.
   */
  initStore(store: JsStore): void {
    this.store = store;

    // Register tree states for each mount
    for (const mount of this.config.mounts) {
      const treeStateId = `workspace/${mount.name}/tree`;
      try {
        store.registerState({
          id: treeStateId,
          strategy: 'tree',
          deltaSnapshotEvery: this.config.deltaSnapshotEvery ?? 50,
          fullSnapshotEvery: this.config.fullSnapshotEvery ?? 10,
        });
      } catch {
        // State already registered (restart scenario)
      }

      const mountState: MountState = {
        config: mount,
        treeStateId,
        lastMaterializedSeq: 0,
        suppressedPaths: new Set(),
        initialSyncDone: false,
        lastMaterializedBranchId: null,
      };
      this.mounts.set(mount.name, mountState);
    }
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Restore persisted state if restarting
    if (ctx.isRestart) {
      const saved = ctx.getState<WorkspaceModuleState>();
      if (saved) {
        for (const [name, meta] of Object.entries(saved.mounts)) {
          const mount = this.mounts.get(name);
          if (mount) {
            mount.lastMaterializedSeq = meta.lastMaterializedSeq;
            mount.lastMaterializedBranchId = meta.lastMaterializedBranchId ?? null;
          }
        }
      }
    }

    // Start watchers for 'always' mode mounts
    for (const [name, mount] of this.mounts) {
      const watchMode = mount.config.watch ?? 'always';
      if (watchMode === 'always') {
        const watcher = new MountWatcher(mount.config, (paths) => {
          this.handleFsChanges(name, paths);
        });
        watcher.start();
        this.watchers.set(name, watcher);
      }

      // Emit mounted event
      this.ctx?.pushEvent({
        type: 'workspace:mounted',
        mount: name,
        path: mount.config.path,
      } as unknown as ProcessEvent);
    }
  }

  async stop(): Promise<void> {
    // Persist state
    if (this.ctx) {
      const activeBranchId = this.store ? this.store.currentBranch().id : undefined;
      const state: WorkspaceModuleState = { mounts: {}, activeBranchId };
      for (const [name, mount] of this.mounts) {
        state.mounts[name] = {
          lastMaterializedSeq: mount.lastMaterializedSeq,
          lastMaterializedBranchId: mount.lastMaterializedBranchId ?? undefined,
        };
      }
      this.ctx.setState(state);
    }

    // Stop watchers
    for (const watcher of this.watchers.values()) {
      watcher.stop();
    }
    this.watchers.clear();
    this.ctx = null;
  }

  // ==========================================================================
  // Tool Definitions
  // ==========================================================================

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'read',
        description: 'Read a file from the workspace. Returns content with line numbers.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (mount-prefixed, e.g., "project/src/main.ts")' },
            offset: { type: 'number', description: 'Starting line number (1-indexed)' },
            limit: { type: 'number', description: 'Maximum number of lines to return' },
          },
          required: ['path'],
        },
      },
      {
        name: 'write',
        description: 'Create or overwrite a file in the workspace.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (mount-prefixed)' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'edit',
        description: 'Edit a file by replacing a substring. The oldString must be unique unless replaceAll is true.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (mount-prefixed)' },
            oldString: { type: 'string', description: 'String to find' },
            newString: { type: 'string', description: 'Replacement string' },
            replaceAll: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
          },
          required: ['path', 'oldString', 'newString'],
        },
      },
      {
        name: 'delete',
        description: 'Delete a file from the workspace.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (mount-prefixed)' },
          },
          required: ['path'],
        },
      },
      {
        name: 'ls',
        description: 'List directory contents from the workspace tree.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Directory path (mount-prefixed, optional)' },
            recursive: { type: 'boolean', description: 'List recursively (default: false)' },
          },
        },
      },
      {
        name: 'glob',
        description: 'Find files matching a glob pattern in the workspace.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts")' },
            path: { type: 'string', description: 'Directory to search in (mount-prefixed, optional)' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'grep',
        description: 'Search file contents with a regex pattern.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            pattern: { type: 'string', description: 'Regular expression pattern' },
            path: { type: 'string', description: 'File or directory to search (mount-prefixed, optional)' },
            glob: { type: 'string', description: 'Glob pattern to filter files' },
            contextBefore: { type: 'number', description: 'Context lines before match' },
            contextAfter: { type: 'number', description: 'Context lines after match' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'status',
        description: 'Show workspace status: mounted directories, pending changes, conflicts.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            mount: { type: 'string', description: 'Specific mount to check (optional)' },
          },
        },
      },
      {
        name: 'materialize',
        description: 'Write workspace files to the real filesystem. Use after writing/editing to push changes to disk.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Specific path to materialize (optional — defaults to all changed)' },
            mount: { type: 'string', description: 'Specific mount (optional)' },
          },
        },
      },
      {
        name: 'sync',
        description: 'Pull filesystem state into the workspace. Detects user changes on disk.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Specific path to sync (optional — defaults to all)' },
            mount: { type: 'string', description: 'Specific mount (optional)' },
          },
        },
      },
    ];
  }

  // ==========================================================================
  // Tool Dispatch
  // ==========================================================================

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    try {
      const input = call.input as Record<string, unknown>;
      switch (call.name) {
        case 'read': return await this.handleRead(input as unknown as ReadInput);
        case 'write': return await this.handleWrite(input as unknown as WriteInput);
        case 'edit': return await this.handleEdit(input as unknown as EditInput);
        case 'delete': return await this.handleDelete(input as unknown as DeleteInput);
        case 'ls': return await this.handleLs(input as unknown as LsInput);
        case 'glob': return await this.handleGlob(input as unknown as GlobInput);
        case 'grep': return await this.handleGrep(input as unknown as GrepInput);
        case 'status': return await this.handleStatus(input as unknown as StatusInput);
        case 'materialize': return await this.handleMaterialize(input as unknown as MaterializeInput);
        case 'sync': return await this.handleSync(input as unknown as SyncInput);
        default:
          return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
      }
    } catch (err) {
      return { success: false, error: String(err), isError: true };
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // ==========================================================================
  // Path Resolution
  // ==========================================================================

  /**
   * Parse a mount-prefixed path into (mountName, relativePath).
   */
  private parsePath(path: string): { mount: MountState; relativePath: string } {
    const slashIdx = path.indexOf('/');
    const mountName = slashIdx >= 0 ? path.slice(0, slashIdx) : path;
    const relativePath = slashIdx >= 0 ? path.slice(slashIdx + 1) : '';

    const mount = this.mounts.get(mountName);
    if (!mount) {
      throw new Error(`Unknown mount: "${mountName}". Available: ${[...this.mounts.keys()].join(', ')}`);
    }
    return { mount, relativePath };
  }

  private getStore(): JsStore {
    if (!this.store) throw new Error('WorkspaceModule: store not initialized. Call initStore() first.');
    return this.store;
  }

  // ==========================================================================
  // Lazy Sync
  // ==========================================================================

  /**
   * Ensure a file is synced from filesystem if not yet in tree (lazy sync).
   */
  private async ensureSynced(mount: MountState, relativePath: string): Promise<void> {
    const store = this.getStore();
    const existing = store.treeGet(mount.treeStateId, relativePath);
    if (existing) return; // Already in tree

    // Try to read from filesystem
    const absolutePath = join(mount.config.path, relativePath);
    try {
      const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile() || fileStat.size > maxSize) return;

      const buffer = await readFile(absolutePath);
      const content = buffer.toString('utf-8');
      const blobHash = store.storeBlob(Buffer.from(content, 'utf-8'), 'text/plain');

      store.treeSet(mount.treeStateId, relativePath, {
        blobHash,
        size: buffer.length,
        mode: 0o644,
      });
    } catch {
      // File doesn't exist on disk — that's fine
    }
  }

  // ==========================================================================
  // Tool Handlers
  // ==========================================================================

  private async handleRead(input: ReadInput): Promise<ToolResult> {
    const { mount, relativePath } = this.parsePath(input.path);
    const store = this.getStore();

    await this.ensureSynced(mount, relativePath);

    const entry = store.treeGet(mount.treeStateId, relativePath);
    if (!entry) {
      return { success: false, error: `File not found: ${input.path}`, isError: true };
    }

    const blob = store.getBlob(entry.blobHash);
    if (!blob) {
      return { success: false, error: `Blob not found for: ${input.path}`, isError: true };
    }

    const content = blob.toString('utf-8');
    const lines = content.split('\n');

    // Apply offset/limit
    const startLine = (input.offset ?? 1) - 1; // Convert to 0-indexed
    const endLine = input.limit ? startLine + input.limit : lines.length;
    const slice = lines.slice(startLine, endLine);

    // Format with line numbers (cat -n style)
    const formatted = slice
      .map((line, i) => `${String(startLine + i + 1).padStart(6)}\t${line}`)
      .join('\n');

    return {
      success: true,
      data: {
        path: input.path,
        totalLines: lines.length,
        fromLine: startLine + 1,
        toLine: Math.min(endLine, lines.length),
        content: formatted,
      },
    };
  }

  private async handleWrite(input: WriteInput): Promise<ToolResult> {
    const { mount, relativePath } = this.parsePath(input.path);
    if (mount.config.mode === 'read-only') {
      return { success: false, error: `Mount "${mount.config.name}" is read-only`, isError: true };
    }

    const store = this.getStore();
    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    if (Buffer.byteLength(input.content) > maxSize) {
      return { success: false, error: `Content exceeds max file size (${maxSize} bytes)`, isError: true };
    }

    const blobHash = store.storeBlob(Buffer.from(input.content, 'utf-8'), 'text/plain');
    store.treeSet(mount.treeStateId, relativePath, {
      blobHash,
      size: Buffer.byteLength(input.content),
      mode: 0o644,
    });

    // On-agent-action sync: check filesystem after our action
    await this.onAgentActionSync(mount);

    return {
      success: true,
      data: {
        path: input.path,
        size: Buffer.byteLength(input.content),
        hash: hashContent(input.content),
      },
    };
  }

  private async handleEdit(input: EditInput): Promise<ToolResult> {
    const { mount, relativePath } = this.parsePath(input.path);
    if (mount.config.mode === 'read-only') {
      return { success: false, error: `Mount "${mount.config.name}" is read-only`, isError: true };
    }

    const store = this.getStore();
    await this.ensureSynced(mount, relativePath);

    const entry = store.treeGet(mount.treeStateId, relativePath);
    if (!entry) {
      return { success: false, error: `File not found: ${input.path}`, isError: true };
    }

    const blob = store.getBlob(entry.blobHash);
    if (!blob) {
      return { success: false, error: `Blob not found for: ${input.path}`, isError: true };
    }

    let content = blob.toString('utf-8');

    // Validate uniqueness
    if (!input.replaceAll) {
      const count = content.split(input.oldString).length - 1;
      if (count === 0) {
        return { success: false, error: `String not found in ${input.path}`, isError: true };
      }
      if (count > 1) {
        return {
          success: false,
          error: `String found ${count} times in ${input.path}. Use replaceAll: true or provide more context.`,
          isError: true,
        };
      }
    }

    content = input.replaceAll
      ? content.replaceAll(input.oldString, input.newString)
      : content.replace(input.oldString, input.newString);

    const newBlobHash = store.storeBlob(Buffer.from(content, 'utf-8'), 'text/plain');
    store.treeSet(mount.treeStateId, relativePath, {
      blobHash: newBlobHash,
      size: Buffer.byteLength(content),
      mode: entry.mode,
    });

    await this.onAgentActionSync(mount);

    return {
      success: true,
      data: {
        path: input.path,
        size: Buffer.byteLength(content),
      },
    };
  }

  private async handleDelete(input: DeleteInput): Promise<ToolResult> {
    const { mount, relativePath } = this.parsePath(input.path);
    if (mount.config.mode === 'read-only') {
      return { success: false, error: `Mount "${mount.config.name}" is read-only`, isError: true };
    }

    const store = this.getStore();
    const entry = store.treeGet(mount.treeStateId, relativePath);
    if (!entry) {
      return { success: false, error: `File not found: ${input.path}`, isError: true };
    }

    store.treeRemove(mount.treeStateId, relativePath);

    await this.onAgentActionSync(mount);

    return { success: true, data: { path: input.path, deleted: true } };
  }

  private async handleLs(input: LsInput): Promise<ToolResult> {
    const store = this.getStore();

    if (!input.path) {
      // List all mounts
      const mounts = [...this.mounts.entries()].map(([name, m]) => ({
        name,
        path: m.config.path,
        mode: m.config.mode,
      }));
      return { success: true, data: { mounts } };
    }

    const { mount, relativePath } = this.parsePath(input.path);

    // Ensure initial sync if needed
    if (!mount.initialSyncDone && mount.config.watch !== 'never') {
      await syncFromFs(store, mount);
      mount.initialSyncDone = true;
    }

    const prefix = relativePath ? relativePath + '/' : '';
    const entries = store.treeList(mount.treeStateId, prefix || undefined);

    if (input.recursive) {
      return {
        success: true,
        data: {
          path: input.path,
          entries: entries.map(e => ({
            path: e.path,
            size: e.size,
          })),
          count: entries.length,
        },
      };
    }

    // Non-recursive: deduplicate to show immediate children only
    const seen = new Set<string>();
    const children: Array<{ name: string; type: 'file' | 'directory' }> = [];

    for (const entry of entries) {
      const rest = entry.path.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx >= 0) {
        const dirName = rest.slice(0, slashIdx);
        if (!seen.has(dirName)) {
          seen.add(dirName);
          children.push({ name: dirName, type: 'directory' });
        }
      } else {
        children.push({ name: rest, type: 'file' });
      }
    }

    return {
      success: true,
      data: {
        path: input.path,
        entries: children,
        count: children.length,
      },
    };
  }

  private async handleGlob(input: GlobInput): Promise<ToolResult> {
    const store = this.getStore();
    const regex = globToRegex(input.pattern);
    const matches: string[] = [];

    // Search across mounts
    const mountsToSearch = input.path
      ? [this.parsePath(input.path)]
      : [...this.mounts.values()].map(m => ({ mount: m, relativePath: '' }));

    for (const { mount, relativePath } of mountsToSearch) {
      if (!mount.initialSyncDone && mount.config.watch !== 'never') {
        await syncFromFs(store, mount);
        mount.initialSyncDone = true;
      }

      const prefix = relativePath ? relativePath + '/' : undefined;
      const entries = store.treeList(mount.treeStateId, prefix);

      for (const entry of entries) {
        const testPath = relativePath ? entry.path.slice(relativePath.length + 1) : entry.path;
        if (regex.test(testPath)) {
          matches.push(`${mount.config.name}/${entry.path}`);
        }
      }
    }

    return {
      success: true,
      data: {
        pattern: input.pattern,
        matches,
        count: matches.length,
      },
    };
  }

  private async handleGrep(input: GrepInput): Promise<ToolResult> {
    const store = this.getStore();
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (e) {
      return { success: false, error: `Invalid regex: ${input.pattern}`, isError: true };
    }

    const fileGlob = input.glob ? globToRegex(input.glob) : null;
    const contextBefore = input.contextBefore ?? 0;
    const contextAfter = input.contextAfter ?? 0;

    const mountsToSearch = input.path
      ? [this.parsePath(input.path)]
      : [...this.mounts.values()].map(m => ({ mount: m, relativePath: '' }));

    const results: Array<{ file: string; matches: Array<{ line: number; text: string; context?: string[] }> }> = [];

    for (const { mount, relativePath } of mountsToSearch) {
      if (!mount.initialSyncDone && mount.config.watch !== 'never') {
        await syncFromFs(store, mount);
        mount.initialSyncDone = true;
      }

      const prefix = relativePath ? relativePath + '/' : undefined;
      const entries = store.treeList(mount.treeStateId, prefix);

      for (const entry of entries) {
        if (fileGlob && !fileGlob.test(entry.path)) continue;

        const blob = store.getBlob(entry.blobHash);
        if (!blob) continue;

        const content = blob.toString('utf-8');
        const lines = content.split('\n');
        const fileMatches: Array<{ line: number; text: string; context?: string[] }> = [];

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const match: { line: number; text: string; context?: string[] } = {
              line: i + 1,
              text: lines[i],
            };
            if (contextBefore > 0 || contextAfter > 0) {
              const start = Math.max(0, i - contextBefore);
              const end = Math.min(lines.length, i + contextAfter + 1);
              match.context = lines.slice(start, end);
            }
            fileMatches.push(match);
          }
        }

        if (fileMatches.length > 0) {
          results.push({
            file: `${mount.config.name}/${entry.path}`,
            matches: fileMatches,
          });
        }
      }
    }

    return {
      success: true,
      data: {
        pattern: input.pattern,
        results,
        totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
      },
    };
  }

  private async handleStatus(_input: StatusInput): Promise<ToolResult> {
    const store = this.getStore();
    const status: Record<string, unknown> = {};

    for (const [name, mount] of this.mounts) {
      const entries = store.treeList(mount.treeStateId);
      const currentSeq = store.currentSequence();
      const changes = mount.lastMaterializedSeq > 0
        ? store.treeDiff(mount.treeStateId, mount.lastMaterializedSeq, currentSeq)
        : [];

      const currentBranch = store.currentBranch();
      status[name] = {
        path: mount.config.path,
        mode: mount.config.mode,
        watch: mount.config.watch ?? 'always',
        fileCount: entries.length,
        lastMaterializedSeq: mount.lastMaterializedSeq,
        currentSeq,
        pendingChanges: changes.length,
        initialSyncDone: mount.initialSyncDone,
        currentBranch: currentBranch.name,
        lastMaterializedBranch: mount.lastMaterializedBranchId,
        canMaterialize: !mount.lastMaterializedBranchId || mount.lastMaterializedBranchId === currentBranch.id,
      };
    }

    return { success: true, data: status };
  }

  private async handleMaterialize(input: MaterializeInput): Promise<ToolResult> {
    const store = this.getStore();

    // Guard: only materialize on the active branch
    if (this.config.materializeOnlyActiveBranch !== false) {
      const currentBranch = store.currentBranch();
      for (const mount of this.mounts.values()) {
        if (mount.lastMaterializedBranchId && mount.lastMaterializedBranchId !== currentBranch.id) {
          return {
            success: false,
            error: `Cannot materialize: current branch "${currentBranch.name}" differs from last materialized branch. Switch back or set materializeOnlyActiveBranch: false.`,
            isError: true,
          };
        }
      }
    }

    const allWritten: Array<{ mount: string; path: string }> = [];

    const mountsToMaterialize = input.mount
      ? [{ name: input.mount, mount: this.mounts.get(input.mount)! }]
      : [...this.mounts.entries()]
          .filter(([, m]) => m.config.mode === 'read-write')
          .map(([name, mount]) => ({ name, mount }));

    for (const { name, mount } of mountsToMaterialize) {
      if (!mount) {
        return { success: false, error: `Unknown mount: ${input.mount}`, isError: true };
      }

      const paths = input.path
        ? [this.parsePath(`${name}/${input.path}`).relativePath]
        : undefined;

      // Suppress watcher for paths we're about to write
      const watcher = this.watchers.get(name);
      const written = await materializeToFs(store, mount, paths);

      for (const p of written) {
        watcher?.suppress(p);
        allWritten.push({ mount: name, path: p });
      }

      // Track which branch we materialized on
      if (written.length > 0) {
        mount.lastMaterializedBranchId = store.currentBranch().id;
      }
    }

    return {
      success: true,
      data: {
        materialized: allWritten,
        count: allWritten.length,
      },
    };
  }

  private async handleSync(input: SyncInput): Promise<ToolResult> {
    const store = this.getStore();
    const allResults: Array<{ mount: string; synced: string[]; conflicts: string[] }> = [];

    const mountsToSync = input.mount
      ? [{ name: input.mount, mount: this.mounts.get(input.mount)! }]
      : [...this.mounts.entries()].map(([name, mount]) => ({ name, mount }));

    for (const { name, mount } of mountsToSync) {
      if (!mount) {
        return { success: false, error: `Unknown mount: ${input.mount}`, isError: true };
      }

      const paths = input.path
        ? [this.parsePath(`${name}/${input.path}`).relativePath]
        : undefined;

      const result = await syncFromFs(store, mount, paths);
      mount.initialSyncDone = true;

      if (result.synced.length > 0 || result.conflicts.length > 0) {
        allResults.push({ mount: name, synced: result.synced, conflicts: result.conflicts });

        // Emit workspace:changed event
        if (this.ctx) {
          const event: WorkspaceChangedEvent = {
            type: 'workspace:changed',
            paths: result.synced.map(p => `${name}/${p}`),
            mount: name,
            conflicts: result.conflicts.length > 0
              ? result.conflicts.map(p => `${name}/${p}`)
              : undefined,
          };
          this.ctx.pushEvent(event as unknown as ProcessEvent);
        }
      }
    }

    return {
      success: true,
      data: {
        results: allResults,
        totalSynced: allResults.reduce((sum, r) => sum + r.synced.length, 0),
        totalConflicts: allResults.reduce((sum, r) => sum + r.conflicts.length, 0),
      },
    };
  }

  // ==========================================================================
  // Internal: Filesystem Change Handling
  // ==========================================================================

  /**
   * Handle filesystem changes detected by watcher (watch: 'always' mode).
   */
  private async handleFsChanges(mountName: string, paths: string[]): Promise<void> {
    const store = this.store;
    const mount = this.mounts.get(mountName);
    if (!store || !mount) return;

    const result = await syncFromFs(store, mount, paths);

    if ((result.synced.length > 0 || result.conflicts.length > 0) && this.ctx) {
      const event: WorkspaceChangedEvent = {
        type: 'workspace:changed',
        paths: result.synced.map(p => `${mountName}/${p}`),
        mount: mountName,
        conflicts: result.conflicts.length > 0
          ? result.conflicts.map(p => `${mountName}/${p}`)
          : undefined,
      };
      this.ctx.pushEvent(event as unknown as ProcessEvent);
    }
  }

  /**
   * For 'on-agent-action' mode: sync filesystem after each agent tool call.
   */
  private async onAgentActionSync(mount: MountState): Promise<void> {
    const watchMode = mount.config.watch ?? 'always';
    if (watchMode !== 'on-agent-action') return;

    const store = this.store;
    if (!store) return;

    const result = await syncFromFs(store, mount);

    if ((result.synced.length > 0 || result.conflicts.length > 0) && this.ctx) {
      const event: WorkspaceChangedEvent = {
        type: 'workspace:changed',
        paths: result.synced.map(p => `${mount.config.name}/${p}`),
        mount: mount.config.name,
        conflicts: result.conflicts.length > 0
          ? result.conflicts.map(p => `${mount.config.name}/${p}`)
          : undefined,
      };
      this.ctx.pushEvent(event as unknown as ProcessEvent);
    }
  }
}

// ==========================================================================
// Utilities
// ==========================================================================

/**
 * Convert a glob pattern to a RegExp.
 */
function globToRegex(pattern: string): RegExp {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${regex}$`);
}
