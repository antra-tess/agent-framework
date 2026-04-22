/**
 * McplServerConnection — manages a single JSON-RPC 2.0 connection to an MCPL server.
 *
 * Spawns a child process (stdio transport), performs the MCP initialize handshake
 * with MCPL capability negotiation, and provides typed methods for all outbound
 * MCPL messages plus EventEmitter events for inbound messages.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

import type {
  McplServerConfig,
  McplCapabilities,
  McplHostCapabilities,
  JsonRpcRequest,
  JsonRpcResponse,
  BeforeInferenceParams,
  BeforeInferenceResult,
  AfterInferenceParams,
  AfterInferenceResult,
  FeatureSetsUpdateParams,
  InferenceChunkParams,
  StateRollbackParams,
  StateRollbackResult,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  ChannelsListResult,
  ChannelsPublishParams,
  ChannelsPublishResult,
  ChannelsOutgoingChunkParams,
  ChannelsOutgoingCompleteParams,
  McpToolDefinition,
  McpToolCallResult,
} from './types.js';

import { McplMethod } from './types.js';

/** Timeout for the initialize handshake in milliseconds.
 *  Spring Boot + JDA servers can take 5-10s to boot, so 30s is safe. */
const INITIALIZE_TIMEOUT_MS = 30_000;

/** MCP protocol version used in the initialize handshake. */
const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * Represents a pending JSON-RPC request awaiting a response.
 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

/**
 * McplServerConnection manages a single JSON-RPC 2.0 connection to an
 * MCPL server over stdio. Use the static `connect()` factory to create
 * and initialize a connection.
 *
 * Events emitted:
 * - `'push-event'`        — Server sent `push/event`
 * - `'inference-request'`  — Server sent `inference/request`
 * - `'scope-elevate'`      — Server sent `scope/elevate`
 * - `'channels-register'`  — Server sent `channels/register`
 * - `'channels-changed'`   — Server sent `channels/changed`
 * - `'channels-incoming'`  — Server sent `channels/incoming`
 * - `'feature-sets-changed'` — Server sent `featureSets/changed`
 * - `'error'`              — Connection-level error
 * - `'close'`              — Connection closed
 */
export class McplServerConnection extends EventEmitter {
  /** Unique server identifier from config. */
  readonly id: string;

  /** MCPL capabilities negotiated during the initialize handshake, or null if the server does not support MCPL. */
  capabilities: McplCapabilities | null;

  private process: ChildProcess;
  private readline: ReadlineInterface;
  private nextRequestId = 1;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private closed = false;

  // Event buffering: events emitted before ready() are queued, not lost
  private readyFlag = false;
  private bufferedEvents: Array<{ event: string; args: unknown[] }> = [];

  // Reconnect state (adapted from Anarchid/agent-framework@mcpl-module-proto)
  private config: McplServerConfig | null = null;
  private hostCapabilities: McplHostCapabilities | null = null;
  private reconnectEnabled = false;
  private reconnectIntervalMs = 5000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Swaps the line handler on the current child's stderr pipe. Re-bound on reconnect. */
  private rebindStderr: ((next: (line: string) => void) => void) | null = null;

  /**
   * Private constructor. Use `McplServerConnection.connect()` instead.
   */
  private constructor(
    id: string,
    capabilities: McplCapabilities | null,
    childProcess: ChildProcess,
    readline: ReadlineInterface,
  ) {
    super();
    this.id = id;
    this.capabilities = capabilities;
    this.process = childProcess;
    this.readline = readline;

    // Skip setup for disconnected stubs (process/readline are null)
    if (childProcess && readline) {
      this.setupMessageRouting();
      this.setupLifecycle();
    }
  }

  // ==========================================================================
  // Event buffering
  // ==========================================================================

  /**
   * Mark the connection as ready — flushes any events that arrived between
   * construction (when setupMessageRouting starts emitting) and now (when
   * the caller has attached listeners via wireMcplEvents).
   */
  ready(): void {
    this.readyFlag = true;
    for (const { event, args } of this.bufferedEvents) {
      super.emit(event, ...args);
    }
    this.bufferedEvents = [];
  }

  /**
   * Override emit to buffer server→host events until ready() is called.
   * Lifecycle events ('close', 'error', 'reconnect') always pass through.
   */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const name = typeof event === 'string' ? event : '';
    if (this.readyFlag || name === 'close' || name === 'error' || name === 'reconnect') {
      return super.emit(event, ...args);
    }
    this.bufferedEvents.push({ event: name, args });
    return true;
  }

  // ==========================================================================
  // Static factory
  // ==========================================================================

  /**
   * Wire stderr forwarding on a child process. Lines are forwarded to the
   * supplied callback. The callback can be swapped at any time via `rebind`
   * (used during reconnect, when we want already-wired pipes to target a new
   * emitter).
   */
  private static wireStderrForwarding(
    child: ChildProcess,
    initialLineHandler: (line: string) => void,
  ): { rebind: (next: (line: string) => void) => void } {
    let onLine = initialLineHandler;
    let carry = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = carry + chunk.toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) onLine(line);
      }
    });
    return {
      rebind(next) {
        onLine = next;
      },
    };
  }

  /**
   * Spawn a server process, perform the MCP initialize handshake with MCPL
   * capability negotiation, and return a ready-to-use connection.
   *
   * Throws if the process cannot be spawned or the handshake times out.
   */
  static async connect(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): Promise<McplServerConnection> {
    const child = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    });

    // Capture child stderr so it isn't silently dropped. During the handshake
    // window (before the instance exists) lines are buffered; the buffer is
    // drained once we have an instance to emit 'stderr' events on.
    const earlyStderrBuffer: string[] = [];
    const attachStderr = McplServerConnection.wireStderrForwarding(child, (line) =>
      earlyStderrBuffer.push(line),
    );

    // Fail fast if the process exits before the handshake completes
    const earlyExitPromise = new Promise<never>((_resolve, reject) => {
      child.on('error', (err) => {
        reject(new Error(`Failed to spawn MCPL server "${config.id}": ${err.message}`));
      });
      child.on('exit', (code) => {
        reject(new Error(`MCPL server "${config.id}" exited before handshake (code ${code})`));
      });
    });

    // Set up readline for newline-delimited JSON on stdout
    const rl = createInterface({ input: child.stdout! });

    // -----------------------------------------------------------------------
    // Perform initialize handshake
    // -----------------------------------------------------------------------

    // Step 1: Send `initialize` request
    const initId = 0; // use id=0 for the handshake
    const initRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'initialize',
      id: initId,
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          experimental: {
            mcpl: hostCapabilities,
          },
        },
        clientInfo: {
          name: 'agent-framework',
          version: '1.0.0',
        },
      },
    };
    child.stdin!.write(JSON.stringify(initRequest) + '\n');

    // Step 2: Wait for the initialize response
    const initResponse = await Promise.race([
      new Promise<JsonRpcResponse>((resolve, reject) => {
        const onLine = (line: string) => {
          try {
            const msg = JSON.parse(line) as JsonRpcResponse;
            if (msg.id === initId) {
              rl.off('line', onLine);
              if (msg.error) {
                reject(new Error(`MCPL server "${config.id}" initialize error: ${msg.error.message}`));
              } else {
                resolve(msg);
              }
            }
          } catch {
            // Ignore non-JSON lines (e.g. logback output from Java servers)
          }
        };
        rl.on('line', onLine);
      }),
      earlyExitPromise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => {
          reject(new Error(`MCPL server "${config.id}" initialize handshake timed out`));
        }, INITIALIZE_TIMEOUT_MS),
      ),
    ]);

    // Parse MCPL capabilities from the response
    const result = initResponse.result as Record<string, unknown> | undefined;
    const caps = result?.capabilities as Record<string, unknown> | undefined;
    const experimental = caps?.experimental as Record<string, unknown> | undefined;
    const mcplCaps = (experimental?.mcpl as McplCapabilities) ?? null;

    // Step 3: Send `initialized` notification (no id)
    const initializedNotification: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };
    child.stdin!.write(JSON.stringify(initializedNotification) + '\n');

    // Remove the early-exit listener so normal close handling takes over
    child.removeAllListeners('exit');
    child.removeAllListeners('error');

    const connection = new McplServerConnection(config.id, mcplCaps, child, rl);

    // Swap the stderr handler to emit events on the instance, then drain
    // anything that arrived during the handshake window. Keep the rebind
    // handle on the instance so reconnect can re-target it later.
    connection.rebindStderr = attachStderr.rebind;
    attachStderr.rebind((line: string) => connection.emit('stderr', { line }));
    for (const line of earlyStderrBuffer) {
      connection.emit('stderr', { line });
    }
    earlyStderrBuffer.length = 0;

    // Store config for reconnection
    if (config.reconnect) {
      connection.config = config;
      connection.hostCapabilities = hostCapabilities;
      connection.reconnectEnabled = true;
      connection.reconnectIntervalMs = config.reconnectIntervalMs ?? 5000;
    }

    return connection;
  }

  /**
   * Connect with reconnect support.
   * When `config.reconnect` is true and the initial connection fails,
   * resolves immediately with null capabilities and retries in the background.
   * Adapted from Anarchid/agent-framework@mcpl-module-proto.
   */
  static async connectWithReconnect(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): Promise<McplServerConnection> {
    try {
      return await McplServerConnection.connect(config, hostCapabilities);
    } catch (error) {
      if (!config.reconnect) {
        throw error;
      }

      // Non-blocking start: create a disconnected stub that will reconnect in background
      console.error(`MCPL server "${config.id}" initial connect failed, will retry:`, (error as Error).message);
      return McplServerConnection.createDisconnectedStub(config, hostCapabilities);
    }
  }

  /**
   * Create a disconnected stub connection that will reconnect in the background.
   * Used when initial connect fails and reconnect is enabled.
   * @internal
   */
  private static createDisconnectedStub(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): McplServerConnection {
    // Use null! for process/readline since the connection is closed
    const stub = new McplServerConnection(config.id, null, null! as ChildProcess, null! as ReadlineInterface);
    stub.closed = true;
    stub.config = config;
    stub.hostCapabilities = hostCapabilities;
    stub.reconnectEnabled = true;
    stub.reconnectIntervalMs = config.reconnectIntervalMs ?? 5000;

    // Schedule background reconnect
    stub.scheduleReconnect();

    return stub;
  }

  /**
   * Extract internals for transfer during reconnection.
   * Strips the source connection — caller takes ownership of the process/readline.
   * @internal Used only by attemptReconnect().
   */
  extractInternals(): { process: ChildProcess; readline: ReadlineInterface } {
    const result = { process: this.process, readline: this.readline };
    // Prevent the source connection from killing the transferred process
    this.closed = true;
    return result;
  }

  // ==========================================================================
  // Outbound requests (return Promises)
  // ==========================================================================

  /** Send `context/beforeInference` and await result. */
  sendBeforeInference(params: BeforeInferenceParams): Promise<BeforeInferenceResult> {
    return this.sendRequest(McplMethod.BeforeInference, params as unknown as Record<string, unknown>) as Promise<BeforeInferenceResult>;
  }

  /**
   * Send `context/afterInference`.
   * When `blocking` is true, sends as a request and awaits the result.
   * When `blocking` is false (or omitted), sends as a notification.
   */
  sendAfterInference(params: AfterInferenceParams, blocking?: boolean): Promise<AfterInferenceResult | void> {
    if (blocking) {
      return this.sendRequest(McplMethod.AfterInference, params as unknown as Record<string, unknown>) as Promise<AfterInferenceResult>;
    }
    this.sendNotification(McplMethod.AfterInference, params as unknown as Record<string, unknown>);
    return Promise.resolve();
  }

  /** Send `featureSets/update` notification. */
  sendFeatureSetsUpdate(params: FeatureSetsUpdateParams): void {
    this.sendNotification(McplMethod.FeatureSetsUpdate, params as unknown as Record<string, unknown>);
  }

  /** Send `inference/chunk` notification. */
  sendInferenceChunk(params: InferenceChunkParams): void {
    this.sendNotification(McplMethod.InferenceChunk, params as unknown as Record<string, unknown>);
  }

  /** Send `state/rollback` request and await result. */
  sendStateRollback(params: StateRollbackParams): Promise<StateRollbackResult> {
    return this.sendRequest(McplMethod.StateRollback, params as unknown as Record<string, unknown>) as Promise<StateRollbackResult>;
  }

  /** Send `channels/open` request and await result. */
  sendChannelsOpen(params: ChannelsOpenParams): Promise<ChannelsOpenResult> {
    return this.sendRequest(McplMethod.ChannelsOpen, params as unknown as Record<string, unknown>) as Promise<ChannelsOpenResult>;
  }

  /** Send `channels/close` request and await result. */
  sendChannelsClose(params: ChannelsCloseParams): Promise<ChannelsCloseResult> {
    return this.sendRequest(McplMethod.ChannelsClose, params as unknown as Record<string, unknown>) as Promise<ChannelsCloseResult>;
  }

  /** Send `channels/list` request and await result. */
  sendChannelsList(): Promise<ChannelsListResult> {
    return this.sendRequest(McplMethod.ChannelsList, {}) as Promise<ChannelsListResult>;
  }

  /**
   * Send `channels/publish`.
   * May be sent as a request (if an ACK is desired) or notification.
   * When `params.stream` is true, sends as a notification (no ACK).
   */
  sendChannelsPublish(params: ChannelsPublishParams): Promise<ChannelsPublishResult | void> {
    if (params.stream) {
      this.sendNotification(McplMethod.ChannelsPublish, params as unknown as Record<string, unknown>);
      return Promise.resolve();
    }
    return this.sendRequest(McplMethod.ChannelsPublish, params as unknown as Record<string, unknown>) as Promise<ChannelsPublishResult>;
  }

  /** Send `channels/outgoing/chunk` notification. */
  sendChannelsOutgoingChunk(params: ChannelsOutgoingChunkParams): void {
    this.sendNotification(McplMethod.ChannelsOutgoingChunk, params as unknown as Record<string, unknown>);
  }

  /** Send `channels/outgoing/complete` notification. */
  sendChannelsOutgoingComplete(params: ChannelsOutgoingCompleteParams): void {
    this.sendNotification(McplMethod.ChannelsOutgoingComplete, params as unknown as Record<string, unknown>);
  }

  /** Send `channels/typing` notification (best-effort). */
  sendChannelsTyping(channelId: string): void {
    this.sendNotification(McplMethod.ChannelsTyping, { channelId });
  }

  // ==========================================================================
  // Standard MCP methods
  // ==========================================================================

  /** Send `tools/list` and return the server's tool definitions. */
  sendToolsList(): Promise<{ tools: McpToolDefinition[] }> {
    return this.sendRequest('tools/list', {}) as Promise<{ tools: McpToolDefinition[] }>;
  }

  /** Send `tools/call` and return the result. Optionally includes state/checkpoint for stateful tools. */
  sendToolsCall(
    name: string,
    args: Record<string, unknown>,
    stateParams?: { state?: unknown; checkpoint?: string },
  ): Promise<McpToolCallResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (stateParams?.state !== undefined) params.state = stateParams.state;
    if (stateParams?.checkpoint !== undefined) params.checkpoint = stateParams.checkpoint;
    return this.sendRequest('tools/call', params) as Promise<McpToolCallResult>;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Close the connection: disable reconnect, kill the child process, and clean up resources. */
  async close(): Promise<void> {
    // Disable reconnect before closing — explicit close means stop retrying
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.closed) {
      return;
    }
    this.closed = true;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error(`Connection to MCPL server "${this.id}" closed while awaiting response for ${pending.method} (id=${id})`));
    }
    this.pendingRequests.clear();

    // Close readline
    if (this.readline) {
      this.readline.close();
    }

    // Kill the child process
    if (this.process && !this.process.killed) {
      this.process.kill();
    }

    // Wait for process to actually exit
    if (this.process) {
      await new Promise<void>((resolve) => {
        if (this.process.exitCode !== null || this.process.killed) {
          resolve();
        } else {
          this.process.once('exit', () => resolve());
        }
      });
    }

    this.emit('close');
  }

  /**
   * Schedule a background reconnection attempt.
   */
  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptReconnect();
    }, this.reconnectIntervalMs);
  }

  /**
   * Attempt to reconnect by spawning a new process and performing the handshake.
   */
  private async attemptReconnect(): Promise<void> {
    if (!this.reconnectEnabled || !this.config || !this.hostCapabilities) return;

    try {
      const fresh = await McplServerConnection.connect(this.config, this.hostCapabilities);
      const internals = fresh.extractInternals();

      // Transfer state from fresh connection to this instance
      this.process = internals.process;
      this.readline = internals.readline;
      this.capabilities = fresh.capabilities;
      this.closed = false;
      this.nextRequestId = 1;
      this.pendingRequests.clear();

      // Re-target stderr forwarding from the throwaway `fresh` instance to `this`.
      if (fresh.rebindStderr) {
        fresh.rebindStderr((line: string) => this.emit('stderr', { line }));
        this.rebindStderr = fresh.rebindStderr;
      }

      // Re-wire message routing and lifecycle on the new process
      this.setupMessageRouting();
      this.setupLifecycle();
      this.readyFlag = true; // Listeners already attached from initial wire

      console.error(`MCPL server "${this.id}" reconnected successfully`);
      this.emit('reconnect');
    } catch (error) {
      console.error(`MCPL server "${this.id}" reconnect failed:`, (error as Error).message);
      this.scheduleReconnect();
    }
  }

  // ==========================================================================
  // Private: message sending
  // ==========================================================================

  /**
   * Send a JSON-RPC request and return a promise that resolves with the result
   * or rejects with a JSON-RPC error.
   */
  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`Cannot send request: connection to "${this.id}" is closed`));
    }

    const id = this.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      id,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
      this.process.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  /**
   * Send a JSON-RPC notification (no `id`, no response expected).
   */
  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }

    const notification: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.process.stdin!.write(JSON.stringify(notification) + '\n');
  }

  // ==========================================================================
  // Private: inbound message routing
  // ==========================================================================

  /**
   * Map from JSON-RPC method name to the EventEmitter event name.
   */
  private static readonly METHOD_TO_EVENT: Record<string, string> = {
    [McplMethod.PushEvent]: 'push-event',
    [McplMethod.InferenceRequest]: 'inference-request',
    [McplMethod.ScopeElevate]: 'scope-elevate',
    [McplMethod.ChannelsRegister]: 'channels-register',
    [McplMethod.ChannelsChanged]: 'channels-changed',
    [McplMethod.ChannelsIncoming]: 'channels-incoming',
    [McplMethod.FeatureSetsChanged]: 'feature-sets-changed',
    'notifications/tools/list_changed': 'tools-list-changed',
  };

  /**
   * Wire up readline to route incoming JSON-RPC messages.
   */
  private setupMessageRouting(): void {
    this.readline.on('line', (line) => {
      let msg: JsonRpcRequest | JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        // Ignore non-JSON lines
        return;
      }

      // Is this a response to one of our outbound requests?
      if ('id' in msg && msg.id != null && !('method' in msg)) {
        this.handleResponse(msg as JsonRpcResponse);
        return;
      }

      // It is an inbound request or notification from the server
      const request = msg as JsonRpcRequest;
      const eventName = McplServerConnection.METHOD_TO_EVENT[request.method];

      if (eventName) {
        // Emit the typed event with params and (for requests) a respond callback
        if (request.id != null) {
          // Server expects a response — provide a respond helper
          this.emit(eventName, request.params, {
            id: request.id,
            respond: (result: unknown) => this.sendResponse(request.id!, result),
            respondError: (code: number, message: string, data?: unknown) =>
              this.sendErrorResponse(request.id!, code, message, data),
          });
        } else {
          // Notification — no response expected
          this.emit(eventName, request.params);
        }
      }
    });
  }

  /**
   * Handle a JSON-RPC response by resolving/rejecting the corresponding pending request.
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return; // Orphaned response — ignore
    }

    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(
        new Error(`MCPL server "${this.id}" returned error for ${pending.method}: [${response.error.code}] ${response.error.message}`),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Send a successful JSON-RPC response back to the server.
   */
  private sendResponse(id: string | number, result: unknown): void {
    if (this.closed) return;
    const response: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.process.stdin!.write(JSON.stringify(response) + '\n');
  }

  /**
   * Send a JSON-RPC error response back to the server.
   */
  private sendErrorResponse(id: string | number, code: number, message: string, data?: unknown): void {
    if (this.closed) return;
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
    this.process.stdin!.write(JSON.stringify(response) + '\n');
  }

  // ==========================================================================
  // Private: lifecycle
  // ==========================================================================

  /**
   * Set up process error/exit handlers.
   */
  private setupLifecycle(): void {
    this.process.on('error', (err) => {
      this.emit('error', new Error(`MCPL server "${this.id}" process error: ${err.message}`));
    });

    this.process.on('exit', (code, signal) => {
      if (!this.closed) {
        this.closed = true;

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(
            new Error(
              `MCPL server "${this.id}" exited unexpectedly (code=${code}, signal=${signal}) while awaiting ${pending.method} (id=${id})`,
            ),
          );
        }
        this.pendingRequests.clear();

        this.emit('close', code, signal);

        // Schedule reconnect if enabled (unexpected exit triggers auto-reconnect)
        if (this.reconnectEnabled) {
          this.scheduleReconnect();
        }
      }
    });
  }
}
