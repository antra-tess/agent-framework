/**
 * McplServerConnection — manages a single JSON-RPC 2.0 connection to an MCPL server.
 *
 * Supports two transports:
 * - **stdio**: Spawns a child process, communicates via newline-delimited JSON on stdin/stdout
 * - **WebSocket**: Connects to a remote server via WebSocket, one JSON-RPC message per frame
 *
 * Both transports perform the MCP initialize handshake with MCPL capability negotiation,
 * and provide the same typed methods for outbound messages and EventEmitter events for inbound.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

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

/** WebSocket ping interval in milliseconds (Proposal 001: 30s). */
const WS_PING_INTERVAL_MS = 30_000;

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
 * Transport abstraction — decouples message framing from protocol logic.
 * stdio: newline-delimited JSON on stdin/stdout
 * WebSocket: one JSON-RPC message per text frame
 */
interface Transport {
  /** Send a JSON string to the server. */
  write(json: string): void;
  /** Register a callback for each incoming message (already parsed line/frame). */
  onMessage(cb: (line: string) => void): void;
  /** Register a callback for transport-level errors. */
  onError(cb: (err: Error) => void): void;
  /** Register a callback for transport close. */
  onClose(cb: (code?: number, signal?: string) => void): void;
  /** Shut down the transport. Returns when fully closed. */
  close(): Promise<void>;
}

/**
 * McplServerConnection manages a single JSON-RPC 2.0 connection to an
 * MCPL server. Supports stdio and WebSocket transports.
 * Use `connect()` for stdio, `connectWebSocket()` for WebSocket,
 * or `connectWithReconnect()` which auto-selects based on config.
 *
 * Events emitted:
 * - `'push-event'`        — Server sent `push/event`
 * - `'state-update'`      — Server sent `state/update`
 * - `'state-get'`         — Server sent `state/get`
 * - `'inference-request'`  — Server sent `inference/request`
 * - `'scope-elevate'`      — Server sent `scope/elevate`
 * - `'channels-register'`  — Server sent `channels/register`
 * - `'channels-changed'`   — Server sent `channels/changed`
 * - `'channels-incoming'`  — Server sent `channels/incoming`
 * - `'feature-sets-changed'` — Server sent `featureSets/changed`
 * - `'branches-list'`     — Server sent `branches/list`
 * - `'branches-current'`  — Server sent `branches/current`
 * - `'branches-create'`   — Server sent `branches/create`
 * - `'branches-switch'`   — Server sent `branches/switch`
 * - `'branches-delete'`   — Server sent `branches/delete`
 * - `'error'`              — Connection-level error
 * - `'close'`              — Connection closed
 */
export class McplServerConnection extends EventEmitter {
  /** Unique server identifier from config. */
  readonly id: string;

  /** MCPL capabilities negotiated during the initialize handshake, or null if the server does not support MCPL. */
  capabilities: McplCapabilities | null;

  private transport: Transport | null;
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

  /**
   * Private constructor. Use `McplServerConnection.connect()` or `connectWebSocket()` instead.
   */
  private constructor(
    id: string,
    capabilities: McplCapabilities | null,
    transport: Transport | null,
  ) {
    super();
    this.id = id;
    this.capabilities = capabilities;
    this.transport = transport;

    // Skip setup for disconnected stubs (transport is null)
    if (transport) {
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
   * Spawn a server process (stdio transport), perform the MCP initialize
   * handshake with MCPL capability negotiation, and return a ready-to-use connection.
   *
   * Throws if the process cannot be spawned or the handshake times out.
   */
  static async connect(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): Promise<McplServerConnection> {
    if (!config.command) {
      throw new Error(`MCPL server "${config.id}": stdio transport requires "command" in config`);
    }

    const child = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    });

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

    // Build the stdio transport
    const transport: Transport = {
      write(json: string) { child.stdin!.write(json + '\n'); },
      onMessage(cb) { rl.on('line', cb); },
      onError(cb) { child.on('error', (err) => cb(err)); },
      onClose(cb) {
        child.on('exit', (code, signal) => cb(code ?? undefined, signal ?? undefined));
      },
      async close() {
        rl.close();
        if (!child.killed) child.kill();
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.killed) resolve();
          else child.once('exit', () => resolve());
        });
      },
    };

    // -----------------------------------------------------------------------
    // Perform initialize handshake
    // -----------------------------------------------------------------------

    const mcplCaps = await McplServerConnection.performHandshake(
      config.id, transport, hostCapabilities, earlyExitPromise,
    );

    // Remove the early-exit listener so normal close handling takes over
    child.removeAllListeners('exit');
    child.removeAllListeners('error');

    const connection = new McplServerConnection(config.id, mcplCaps, transport);

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
   * Connect to a remote MCPL server via WebSocket, perform the MCP initialize
   * handshake with MCPL capability negotiation, and return a ready-to-use connection.
   *
   * Throws if the WebSocket connection fails or the handshake times out.
   */
  static async connectWebSocket(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): Promise<McplServerConnection> {
    if (!config.url) {
      throw new Error(`MCPL server "${config.id}": WebSocket transport requires "url" in config`);
    }

    // Append token as query parameter if provided
    let wsUrl = config.url;
    if (config.token) {
      const separator = wsUrl.includes('?') ? '&' : '?';
      wsUrl = `${wsUrl}${separator}token=${encodeURIComponent(config.token)}`;
    }

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.once('open', () => {
        socket.removeListener('error', reject);
        resolve(socket);
      });
      socket.once('error', (err) => {
        reject(new Error(`Failed to connect to MCPL server "${config.id}" at ${config.url}: ${err.message}`));
      });
    });

    // Heartbeat: ping every 30s, close if no pong within 60s
    let pongReceived = true;
    const pingInterval = setInterval(() => {
      if (!pongReceived) {
        ws.terminate();
        return;
      }
      pongReceived = false;
      ws.ping();
    }, WS_PING_INTERVAL_MS);

    ws.on('pong', () => { pongReceived = true; });

    // Build the WebSocket transport
    const transport: Transport = {
      write(json: string) { ws.send(json); },
      onMessage(cb) { ws.on('message', (data: WebSocket.RawData) => cb(data.toString())); },
      onError(cb) { ws.on('error', (err: Error) => cb(err)); },
      onClose(cb) { ws.on('close', (code: number) => cb(code)); },
      async close() {
        clearInterval(pingInterval);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          await new Promise<void>((resolve) => ws.once('close', () => resolve()));
        }
      },
    };

    // Fail fast if the WebSocket closes during handshake
    const earlyClosePromise = new Promise<never>((_resolve, reject) => {
      ws.once('close', (code) => {
        reject(new Error(`MCPL server "${config.id}" WebSocket closed before handshake (code ${code})`));
      });
    });

    const mcplCaps = await McplServerConnection.performHandshake(
      config.id, transport, hostCapabilities, earlyClosePromise,
    );

    // Remove the early-close listener so normal close handling takes over
    ws.removeAllListeners('close');
    // Re-attach the transport's onClose since we just removed it
    transport.onClose = (cb) => { ws.on('close', (code) => cb(code)); };

    const connection = new McplServerConnection(config.id, mcplCaps, transport);

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
   * Perform the MCP initialize handshake over a transport.
   * Shared by both stdio and WebSocket factories.
   */
  private static async performHandshake(
    serverId: string,
    transport: Transport,
    hostCapabilities: McplHostCapabilities,
    earlyFailPromise: Promise<never>,
  ): Promise<McplCapabilities | null> {
    // Step 1: Send `initialize` request
    const initId = 0;
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
    transport.write(JSON.stringify(initRequest));

    // Step 2: Wait for the initialize response
    const initResponse = await Promise.race([
      new Promise<JsonRpcResponse>((resolve, reject) => {
        const onMessage = (line: string) => {
          try {
            const msg = JSON.parse(line) as JsonRpcResponse;
            if (msg.id === initId) {
              // Can't remove listener from transport interface, but the handler
              // becomes a no-op after first match since we resolve/reject once
              if (msg.error) {
                reject(new Error(`MCPL server "${serverId}" initialize error: ${msg.error.message}`));
              } else {
                resolve(msg);
              }
            }
          } catch {
            // Ignore non-JSON lines (e.g. logback output from Java servers)
          }
        };
        transport.onMessage(onMessage);
      }),
      earlyFailPromise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => {
          reject(new Error(`MCPL server "${serverId}" initialize handshake timed out`));
        }, INITIALIZE_TIMEOUT_MS),
      ),
    ]);

    // Parse MCPL capabilities from the response
    const result = initResponse.result as Record<string, unknown> | undefined;
    const caps = result?.capabilities as Record<string, unknown> | undefined;
    const experimental = caps?.experimental as Record<string, unknown> | undefined;
    const mcplCaps = (experimental?.mcpl as McplCapabilities) ?? null;

    // Step 3: Send `initialized` notification
    const initializedNotification: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };
    transport.write(JSON.stringify(initializedNotification));

    return mcplCaps;
  }

  /**
   * Connect with the appropriate transport based on config (stdio or WebSocket).
   */
  private static connectAuto(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): Promise<McplServerConnection> {
    if (config.url) {
      return McplServerConnection.connectWebSocket(config, hostCapabilities);
    }
    return McplServerConnection.connect(config, hostCapabilities);
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
      return await McplServerConnection.connectAuto(config, hostCapabilities);
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
    const stub = new McplServerConnection(config.id, null, null);
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
   * Extract transport for transfer during reconnection.
   * Strips the source connection — caller takes ownership of the transport.
   * @internal Used only by attemptReconnect().
   */
  extractTransport(): Transport | null {
    const result = this.transport;
    // Prevent the source connection from closing the transferred transport
    this.transport = null;
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

  /** Send `branches/changed` notification. */
  sendBranchesChanged(params: import('./types.js').BranchesChangedParams): void {
    this.sendNotification(McplMethod.BranchesChanged, params as unknown as Record<string, unknown>);
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

  /** Close the connection: disable reconnect, close the transport, and clean up resources. */
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

    // Close the transport
    if (this.transport) {
      await this.transport.close();
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
   * Attempt to reconnect using the appropriate transport.
   */
  private async attemptReconnect(): Promise<void> {
    if (!this.reconnectEnabled || !this.config || !this.hostCapabilities) return;

    try {
      const fresh = await McplServerConnection.connectAuto(this.config, this.hostCapabilities);
      const transport = fresh.extractTransport();

      // Transfer state from fresh connection to this instance
      this.transport = transport;
      this.capabilities = fresh.capabilities;
      this.closed = false;
      this.nextRequestId = 1;
      this.pendingRequests.clear();

      // Re-wire message routing and lifecycle on the new transport
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
    if (this.closed || !this.transport) {
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
      this.transport!.write(JSON.stringify(request));
    });
  }

  /**
   * Send a JSON-RPC notification (no `id`, no response expected).
   */
  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (this.closed || !this.transport) {
      return;
    }

    const notification: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.transport.write(JSON.stringify(notification));
  }

  // ==========================================================================
  // Private: inbound message routing
  // ==========================================================================

  /**
   * Map from JSON-RPC method name to the EventEmitter event name.
   */
  private static readonly METHOD_TO_EVENT: Record<string, string> = {
    [McplMethod.PushEvent]: 'push-event',
    [McplMethod.StateUpdate]: 'state-update',
    [McplMethod.StateGet]: 'state-get',
    [McplMethod.InferenceRequest]: 'inference-request',
    [McplMethod.ScopeElevate]: 'scope-elevate',
    [McplMethod.ChannelsRegister]: 'channels-register',
    [McplMethod.ChannelsChanged]: 'channels-changed',
    [McplMethod.ChannelsIncoming]: 'channels-incoming',
    [McplMethod.FeatureSetsChanged]: 'feature-sets-changed',
    [McplMethod.BranchesList]: 'branches-list',
    [McplMethod.BranchesCurrent]: 'branches-current',
    [McplMethod.BranchesCreate]: 'branches-create',
    [McplMethod.BranchesSwitch]: 'branches-switch',
    [McplMethod.BranchesDelete]: 'branches-delete',
    'notifications/tools/list_changed': 'tools-list-changed',
  };

  /**
   * Wire up the transport to route incoming JSON-RPC messages.
   */
  private setupMessageRouting(): void {
    this.transport!.onMessage((line) => {
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
    if (this.closed || !this.transport) return;
    const response: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.transport.write(JSON.stringify(response));
  }

  /**
   * Send a JSON-RPC error response back to the server.
   */
  private sendErrorResponse(id: string | number, code: number, message: string, data?: unknown): void {
    if (this.closed || !this.transport) return;
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
    this.transport.write(JSON.stringify(response));
  }

  // ==========================================================================
  // Private: lifecycle
  // ==========================================================================

  /**
   * Set up transport error/close handlers.
   */
  private setupLifecycle(): void {
    this.transport!.onError((err) => {
      this.emit('error', new Error(`MCPL server "${this.id}" transport error: ${err.message}`));
    });

    this.transport!.onClose((code, signal) => {
      if (!this.closed) {
        this.closed = true;

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(
            new Error(
              `MCPL server "${this.id}" closed unexpectedly (code=${code}, signal=${signal}) while awaiting ${pending.method} (id=${id})`,
            ),
          );
        }
        this.pendingRequests.clear();

        this.emit('close', code, signal);

        // Schedule reconnect if enabled (unexpected close triggers auto-reconnect)
        if (this.reconnectEnabled) {
          this.scheduleReconnect();
        }
      }
    });
  }
}
