/**
 * Files Module - File editing with branching support
 *
 * Provides tools for reading, writing, and editing files stored in Chronicle.
 * Files can be materialized to the filesystem for script execution.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import type { JsStore } from 'chronicle';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '../../types/index.js';
import type {
  WorkspaceIndex,
  FileEntry,
  ContentLogEntry,
  FilesModuleConfig,
  ReadInput,
  WriteInput,
  EditInput,
  GlobInput,
  GrepInput,
  MaterializeInput,
  SyncInput,
} from './types.js';

export * from './types.js';

const DEFAULT_CONFIG: Required<FilesModuleConfig> = {
  namespace: 'workspace',
  deltaSnapshotEvery: 20,
  fullSnapshotEvery: 10,
  maxFileSize: 5 * 1024 * 1024, // 5MB
};

/**
 * Files module for the agent framework.
 */
export class FilesModule implements Module {
  readonly name = 'files';

  private config: Required<FilesModuleConfig>;
  private ctx: ModuleContext | null = null;
  private store: JsStore | null = null;
  private indexStateId: string;

  constructor(config: FilesModuleConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.indexStateId = `${this.config.namespace}/index`;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    // Store is accessed via framework - we'll get it from context
    // For now, we need the store passed in or accessed differently
    // This is a limitation we'll need to address in the framework
  }

  /**
   * Initialize with a store reference.
   * Called by the framework after start().
   */
  initStore(store: JsStore): void {
    this.store = store;

    // Register index state
    try {
      store.registerState({
        id: this.indexStateId,
        strategy: 'snapshot',
      });
    } catch {
      // Already registered
    }

    // Initialize index if empty
    const index = this.getIndex();
    if (!index) {
      this.setIndex({ files: {}, nextStateId: 1 });
    }
  }

  async stop(): Promise<void> {
    this.ctx = null;
    this.store = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'read',
        description:
          'Read file content. Returns the file content with line numbers. Use offset and limit for large files.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the file to read',
            },
            offset: {
              type: 'number',
              description: 'Starting line number (1-indexed)',
            },
            limit: {
              type: 'number',
              description: 'Number of lines to read',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'write',
        description:
          'Create or overwrite a file with the given content. Use edit for partial changes.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the file to write',
            },
            content: {
              type: 'string',
              description: 'Content to write to the file',
            },
          },
          required: ['filePath', 'content'],
        },
      },
      {
        name: 'edit',
        description:
          'Edit a file by replacing a string. The old_string must be unique in the file unless replace_all is true.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the file to edit',
            },
            oldString: {
              type: 'string',
              description: 'String to find and replace (must be unique unless replaceAll)',
            },
            newString: {
              type: 'string',
              description: 'String to replace with',
            },
            replaceAll: {
              type: 'boolean',
              description: 'If true, replace all occurrences',
            },
          },
          required: ['filePath', 'oldString', 'newString'],
        },
      },
      {
        name: 'glob',
        description: 'Find files matching a glob pattern.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Glob pattern (e.g., "**/*.ts", "src/*.js")',
            },
            path: {
              type: 'string',
              description: 'Directory to search in (optional)',
            },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'grep',
        description: 'Search file contents using a regular expression.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Regular expression pattern',
            },
            path: {
              type: 'string',
              description: 'File or directory to search in (optional)',
            },
            glob: {
              type: 'string',
              description: 'Glob pattern to filter files (optional)',
            },
            contextBefore: {
              type: 'number',
              description: 'Lines of context before match',
            },
            contextAfter: {
              type: 'number',
              description: 'Lines of context after match',
            },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'materialize',
        description: 'Write workspace files to the filesystem for script execution.',
        inputSchema: {
          type: 'object',
          properties: {
            targetDir: {
              type: 'string',
              description: 'Target directory to write files to',
            },
            files: {
              type: 'array',
              description: 'Specific files to materialize (optional, defaults to all)',
              items: { type: 'string' },
            },
          },
          required: ['targetDir'],
        },
      },
      {
        name: 'sync',
        description: 'Sync filesystem changes back to the workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceDir: {
              type: 'string',
              description: 'Source directory to sync from',
            },
            files: {
              type: 'array',
              description: 'Specific files to sync (optional, defaults to all)',
              items: { type: 'string' },
            },
          },
          required: ['sourceDir'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (!this.store) {
      return { success: false, error: 'Store not initialized', isError: true };
    }

    try {
      switch (call.name) {
        case 'read':
          return await this.handleRead(call.input as ReadInput);
        case 'write':
          return await this.handleWrite(call.input as WriteInput);
        case 'edit':
          return await this.handleEdit(call.input as EditInput);
        case 'glob':
          return await this.handleGlob(call.input as GlobInput);
        case 'grep':
          return await this.handleGrep(call.input as GrepInput);
        case 'materialize':
          return await this.handleMaterialize(call.input as MaterializeInput);
        case 'sync':
          return await this.handleSync(call.input as SyncInput);
        default:
          return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    // Files module doesn't handle process events
    return {};
  }

  // ==========================================================================
  // Public API (for programmatic access)
  // ==========================================================================

  /**
   * Check if a file exists.
   */
  exists(filePath: string): boolean {
    const index = this.getIndex();
    return filePath in index.files;
  }

  /**
   * List all files in the workspace.
   */
  listFiles(): string[] {
    const index = this.getIndex();
    return Object.keys(index.files);
  }

  /**
   * Get file metadata.
   */
  getFileInfo(filePath: string): FileEntry | null {
    const index = this.getIndex();
    return index.files[filePath] ?? null;
  }

  /**
   * Read file content.
   */
  readFile(filePath: string): string | null {
    const index = this.getIndex();
    const entry = index.files[filePath];
    if (!entry) {
      return null;
    }
    return this.reconstructFile(entry.stateId);
  }

  /**
   * Write file content (create or overwrite).
   */
  writeFile(filePath: string, content: string): void {
    if (content.length > this.config.maxFileSize) {
      throw new Error(`File too large: ${content.length} bytes (max: ${this.config.maxFileSize})`);
    }

    const index = this.getIndex();
    const existing = index.files[filePath];

    if (existing) {
      // Append write entry to existing file
      this.appendToContentLog(existing.stateId, { type: 'write', content });
      index.files[filePath] = {
        ...existing,
        size: content.length,
        hash: this.hashContent(content),
        modifiedAt: Date.now(),
      };
    } else {
      // Create new file
      const stateId = this.createContentState(content);
      index.files[filePath] = {
        stateId,
        size: content.length,
        hash: this.hashContent(content),
        createdAt: Date.now(),
        modifiedAt: Date.now(),
      };
    }

    this.setIndex(index);
  }

  /**
   * Edit file with string replacement.
   */
  editFile(filePath: string, oldString: string, newString: string, replaceAll = false): void {
    const index = this.getIndex();
    const entry = index.files[filePath];
    if (!entry) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Validate edit
    const content = this.reconstructFile(entry.stateId);
    if (content === null) {
      throw new Error(`Failed to read file: ${filePath}`);
    }

    if (!replaceAll) {
      const count = content.split(oldString).length - 1;
      if (count === 0) {
        throw new Error(`String not found in file: ${oldString.substring(0, 50)}...`);
      }
      if (count > 1) {
        throw new Error(
          `String appears ${count} times in file. Use replaceAll or provide more context.`
        );
      }
    }

    // Apply edit
    this.appendToContentLog(entry.stateId, {
      type: 'edit',
      oldString,
      newString,
      replaceAll,
    });

    // Update index
    const newContent = replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString);

    index.files[filePath] = {
      ...entry,
      size: newContent.length,
      hash: this.hashContent(newContent),
      modifiedAt: Date.now(),
    };
    this.setIndex(index);
  }

  /**
   * Delete a file.
   */
  deleteFile(filePath: string): void {
    const index = this.getIndex();
    if (!(filePath in index.files)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Note: We don't delete the content state - it remains for history/branching
    delete index.files[filePath];
    this.setIndex(index);
  }

  // ==========================================================================
  // Tool Handlers
  // ==========================================================================

  private async handleRead(input: ReadInput): Promise<ToolResult> {
    const content = this.readFile(input.filePath);
    if (content === null) {
      return { success: false, error: `File not found: ${input.filePath}`, isError: true };
    }

    const lines = content.split('\n');
    const start = (input.offset ?? 1) - 1;
    const end = input.limit ? start + input.limit : lines.length;
    const selectedLines = lines.slice(start, end);

    // Format with line numbers (like cat -n)
    const formatted = selectedLines
      .map((line, i) => {
        const lineNum = start + i + 1;
        return `${String(lineNum).padStart(6)}\t${line}`;
      })
      .join('\n');

    return {
      success: true,
      data: {
        content: formatted,
        totalLines: lines.length,
        startLine: start + 1,
        endLine: Math.min(end, lines.length),
      },
    };
  }

  private async handleWrite(input: WriteInput): Promise<ToolResult> {
    this.writeFile(input.filePath, input.content);
    return {
      success: true,
      data: { path: input.filePath, size: input.content.length },
    };
  }

  private async handleEdit(input: EditInput): Promise<ToolResult> {
    this.editFile(input.filePath, input.oldString, input.newString, input.replaceAll);
    return {
      success: true,
      data: { path: input.filePath, edited: true },
    };
  }

  private async handleGlob(input: GlobInput): Promise<ToolResult> {
    const index = this.getIndex();
    const allPaths = Object.keys(index.files);

    // Simple glob matching (supports * and **)
    const pattern = input.pattern;
    const basePath = input.path ?? '';

    const regex = this.globToRegex(pattern);
    const matches = allPaths.filter((p) => {
      const relativePath = basePath ? relative(basePath, p) : p;
      return regex.test(relativePath);
    });

    return {
      success: true,
      data: { files: matches, count: matches.length },
    };
  }

  private async handleGrep(input: GrepInput): Promise<ToolResult> {
    const index = this.getIndex();
    let filesToSearch = Object.keys(index.files);

    // Filter by path
    if (input.path) {
      filesToSearch = filesToSearch.filter(
        (p) => p === input.path || p.startsWith(input.path + '/')
      );
    }

    // Filter by glob
    if (input.glob) {
      const regex = this.globToRegex(input.glob);
      filesToSearch = filesToSearch.filter((p) => regex.test(p));
    }

    const regex = new RegExp(input.pattern, 'g');
    const contextBefore = input.contextBefore ?? 0;
    const contextAfter = input.contextAfter ?? 0;

    const results: Array<{
      file: string;
      matches: Array<{
        line: number;
        content: string;
        context?: string[];
      }>;
    }> = [];

    for (const filePath of filesToSearch) {
      const content = this.readFile(filePath);
      if (!content) continue;

      const lines = content.split('\n');
      const fileMatches: Array<{ line: number; content: string; context?: string[] }> = [];

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const match: { line: number; content: string; context?: string[] } = {
            line: i + 1,
            content: lines[i],
          };

          if (contextBefore > 0 || contextAfter > 0) {
            const start = Math.max(0, i - contextBefore);
            const end = Math.min(lines.length, i + contextAfter + 1);
            match.context = lines.slice(start, end);
          }

          fileMatches.push(match);
        }
        regex.lastIndex = 0; // Reset regex state
      }

      if (fileMatches.length > 0) {
        results.push({ file: filePath, matches: fileMatches });
      }
    }

    return {
      success: true,
      data: { results, totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0) },
    };
  }

  private async handleMaterialize(input: MaterializeInput): Promise<ToolResult> {
    const index = this.getIndex();
    const filesToWrite = input.files ?? Object.keys(index.files);
    const written: string[] = [];

    for (const filePath of filesToWrite) {
      if (!(filePath in index.files)) {
        continue;
      }

      const content = this.readFile(filePath);
      if (content === null) continue;

      const targetPath = join(input.targetDir, filePath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, 'utf-8');
      written.push(filePath);
    }

    return {
      success: true,
      data: { targetDir: input.targetDir, files: written, count: written.length },
    };
  }

  private async handleSync(input: SyncInput): Promise<ToolResult> {
    const sourceDir = resolve(input.sourceDir);
    const synced: string[] = [];

    const syncFile = async (fsPath: string, workspacePath: string) => {
      const content = await readFile(fsPath, 'utf-8');
      const existing = this.readFile(workspacePath);

      if (existing !== content) {
        this.writeFile(workspacePath, content);
        synced.push(workspacePath);
      }
    };

    const walkDir = async (dir: string, base: string) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fsPath = join(dir, entry.name);
        const workspacePath = join(base, entry.name);

        if (entry.isDirectory()) {
          await walkDir(fsPath, workspacePath);
        } else if (entry.isFile()) {
          if (input.files && !input.files.includes(workspacePath)) {
            continue;
          }
          await syncFile(fsPath, workspacePath);
        }
      }
    };

    if (input.files) {
      // Sync specific files
      for (const filePath of input.files) {
        const fsPath = join(sourceDir, filePath);
        try {
          const s = await stat(fsPath);
          if (s.isFile()) {
            await syncFile(fsPath, filePath);
          }
        } catch {
          // File doesn't exist on filesystem
        }
      }
    } else {
      // Sync all files
      await walkDir(sourceDir, '');
    }

    return {
      success: true,
      data: { sourceDir: input.sourceDir, files: synced, count: synced.length },
    };
  }

  // ==========================================================================
  // Internal Helpers
  // ==========================================================================

  private getIndex(): WorkspaceIndex {
    if (!this.store) {
      throw new Error('Store not initialized');
    }
    const index = this.store.getStateJson(this.indexStateId) as WorkspaceIndex | null;
    return index ?? { files: {}, nextStateId: 1 };
  }

  private setIndex(index: WorkspaceIndex): void {
    if (!this.store) {
      throw new Error('Store not initialized');
    }
    this.store.setStateJson(this.indexStateId, index);
  }

  private createContentState(initialContent: string): string {
    if (!this.store) {
      throw new Error('Store not initialized');
    }

    const index = this.getIndex();
    const stateId = `${this.config.namespace}/content/${index.nextStateId}`;
    index.nextStateId++;
    this.setIndex(index);

    // Register content state
    this.store.registerState({
      id: stateId,
      strategy: 'append_log',
      deltaSnapshotEvery: this.config.deltaSnapshotEvery,
      fullSnapshotEvery: this.config.fullSnapshotEvery,
    });

    // Initialize with content
    this.appendToContentLog(stateId, { type: 'init', content: initialContent });

    return stateId;
  }

  private appendToContentLog(stateId: string, entry: ContentLogEntry): void {
    if (!this.store) {
      throw new Error('Store not initialized');
    }
    this.store.appendToStateJson(stateId, entry);
  }

  private reconstructFile(stateId: string): string | null {
    if (!this.store) {
      return null;
    }

    const entries = this.store.getStateJson(stateId) as ContentLogEntry[] | null;
    if (!entries || entries.length === 0) {
      return null;
    }

    let content = '';
    for (const entry of entries) {
      switch (entry.type) {
        case 'init':
        case 'write':
          content = entry.content;
          break;
        case 'edit':
          if (entry.replaceAll) {
            content = content.replaceAll(entry.oldString, entry.newString);
          } else {
            content = content.replace(entry.oldString, entry.newString);
          }
          break;
      }
    }

    return content;
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  private globToRegex(pattern: string): RegExp {
    // Convert glob pattern to regex
    let regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\*\*/g, '{{GLOBSTAR}}') // Temporarily replace **
      .replace(/\*/g, '[^/]*') // * matches anything except /
      .replace(/{{GLOBSTAR}}/g, '.*') // ** matches anything
      .replace(/\?/g, '[^/]'); // ? matches single char except /

    return new RegExp(`^${regex}$`);
  }
}
