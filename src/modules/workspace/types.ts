/**
 * Types for the Workspace module
 */

// ============================================================================
// Mount Configuration
// ============================================================================

/**
 * Configuration for a single filesystem mount.
 */
export interface MountConfig {
  /** Mount name — becomes the path prefix (e.g., "project", "config") */
  name: string;
  /** Absolute filesystem path to mount */
  path: string;
  /** Access mode */
  mode: 'read-write' | 'read-only';
  /**
   * Watch mode for filesystem changes:
   * - 'always': chokidar watches continuously, syncs on debounce
   * - 'on-agent-action': sync from filesystem after each agent tool call
   * - 'never': fully virtual, no automatic filesystem reads
   */
  watch?: 'always' | 'on-agent-action' | 'never';
  /** Debounce window in ms for watch: 'always' mode (default: 300) */
  watchDebounceMs?: number;
  /**
   * Simple ignore patterns (NOT full gitignore syntax). Supported forms:
   * - Exact name match: ".git", "node_modules"
   * - Directory glob: "node_modules/**" (anything under node_modules)
   * - Extension glob: "*.pyc" (any file ending in .pyc)
   */
  ignore?: string[];
  /** Whether to follow symlinks (default: false) */
  followSymlinks?: boolean;
  /** Maximum file size in bytes (default: 5MB) */
  maxFileSize?: number;
  /**
   * If set, filesystem changes on this mount request inference.
   * - `true` — wake on any op (created | modified | deleted)
   * - array — wake only for the listed ops
   *
   * Self-writes through the module's own tools are already suppressed by the
   * watcher, so a mount shared between agents only wakes on external writes.
   * The EventGate still has final say — use gate policies for path-glob
   * filtering or to disable wake temporarily via hot-reload.
   */
  wakeOnChange?: boolean | Array<'created' | 'modified' | 'deleted'>;
}

/**
 * Configuration for the WorkspaceModule.
 */
export interface WorkspaceConfig {
  /** Mount configurations */
  mounts: MountConfig[];
  /** Only materialize the active branch to filesystem (default: true) */
  materializeOnlyActiveBranch?: boolean;
  /** Delta snapshot frequency for tree states (default: 50) */
  deltaSnapshotEvery?: number;
  /** Full snapshot frequency for tree states (default: 10) */
  fullSnapshotEvery?: number;
}

// ============================================================================
// Internal State
// ============================================================================

/**
 * Per-mount runtime state (not persisted — rebuilt on start).
 */
export interface MountState {
  /** The mount config */
  config: MountConfig;
  /** Tree state ID in Chronicle */
  treeStateId: string;
  /** Sequence number of last materialization */
  lastMaterializedSeq: number;
  /** Paths currently suppressed from watcher (recently materialized) */
  suppressedPaths: Set<string>;
  /** Whether initial lazy sync has been completed */
  initialSyncDone: boolean;
  /** Branch ID that was active when this mount last materialized */
  lastMaterializedBranchId: string | null;
  /** Per-file hash at time of last materialization — baseline for conflict detection */
  materializedHashes: Map<string, string>;
}

/**
 * Persisted module state (via Chronicle snapshot).
 */
export interface WorkspaceModuleState {
  /** Per-mount metadata */
  mounts: Record<string, {
    lastMaterializedSeq: number;
    lastMaterializedBranchId?: string;
  }>;
  /** Branch ID considered "active" for materialization */
  activeBranchId?: string;
}

// ============================================================================
// Tool Inputs
// ============================================================================

export interface ReadInput {
  /** File path (mount-prefixed, e.g., "project/src/main.ts") */
  path: string;
  /** Starting line (1-indexed, optional) */
  offset?: number;
  /** Number of lines to read (optional) */
  limit?: number;
}

export interface WriteInput {
  /** File path (mount-prefixed) */
  path: string;
  /** Content to write */
  content: string;
}

export interface EditInput {
  /** File path (mount-prefixed) */
  path: string;
  /** String to find */
  oldString: string;
  /** String to replace with */
  newString: string;
  /** Replace all occurrences (default: false) */
  replaceAll?: boolean;
}

export interface DeleteInput {
  /** File path (mount-prefixed) */
  path: string;
}

export interface LsInput {
  /** Directory path (mount-prefixed, optional — defaults to workspace root) */
  path?: string;
  /** List recursively (default: false) */
  recursive?: boolean;
}

export interface GlobInput {
  /** Glob pattern */
  pattern: string;
  /** Directory to search in (mount-prefixed, optional) */
  path?: string;
}

export interface GrepInput {
  /** Regex pattern */
  pattern: string;
  /** File or directory to search in (mount-prefixed, optional) */
  path?: string;
  /** Glob pattern to filter files */
  glob?: string;
  /** Context lines before match */
  contextBefore?: number;
  /** Context lines after match */
  contextAfter?: number;
}

export interface StatusInput {
  /** Specific mount to check (optional — defaults to all) */
  mount?: string;
}

export interface MaterializeInput {
  /** Specific file or directory path to materialize (optional — defaults to all) */
  path?: string;
  /** Specific mount (optional — defaults to all read-write mounts) */
  mount?: string;
}

export interface SyncInput {
  /** Specific file or directory path to sync (optional — defaults to all) */
  path?: string;
  /** Specific mount (optional — defaults to all) */
  mount?: string;
}

// ============================================================================
// Events
// ============================================================================

export type WorkspaceFsOp = 'created' | 'modified' | 'deleted';

/**
 * Fired when files in a mount are created. `paths` are mount-prefixed
 * (e.g. "tickets/2026-04-20-foo.md"). Conflicts are reported when Chronicle
 * sync detected divergence between the filesystem and the tree state.
 */
export interface WorkspaceCreatedEvent {
  type: 'workspace:created';
  paths: string[];
  mount: string;
  conflicts?: string[];
  [key: string]: unknown;
}

export interface WorkspaceModifiedEvent {
  type: 'workspace:modified';
  paths: string[];
  mount: string;
  conflicts?: string[];
  [key: string]: unknown;
}

export interface WorkspaceDeletedEvent {
  type: 'workspace:deleted';
  paths: string[];
  mount: string;
  [key: string]: unknown;
}

export interface WorkspaceMountedEvent {
  type: 'workspace:mounted';
  mount: string;
  path: string;
  [key: string]: unknown;
}

export interface WorkspaceUnmountedEvent {
  type: 'workspace:unmounted';
  mount: string;
  [key: string]: unknown;
}

export type WorkspaceEvent =
  | WorkspaceCreatedEvent
  | WorkspaceModifiedEvent
  | WorkspaceDeletedEvent
  | WorkspaceMountedEvent
  | WorkspaceUnmountedEvent;

export const WORKSPACE_FS_EVENT_TYPES = [
  'workspace:created',
  'workspace:modified',
  'workspace:deleted',
] as const;

export type WorkspaceFsEventType = typeof WORKSPACE_FS_EVENT_TYPES[number];

export function opToEventType(op: WorkspaceFsOp): WorkspaceFsEventType {
  return `workspace:${op}` as WorkspaceFsEventType;
}
