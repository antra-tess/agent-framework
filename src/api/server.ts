/**
 * WebSocket API Server for the agent framework
 *
 * Provides real-time bidirectional communication:
 * - Commands from clients (send messages, branch, inspect)
 * - Events from framework (inference, tools, speech)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { ContentBlock } from 'membrane';
import type { AgentFramework } from '../framework.js';
import type { TraceEvent, ProcessEvent } from '../types/index.js';
import type {
  ApiServerConfig,
  ApiRequest,
  ApiResponse,
  ApiEvent,
  MessageSendParams,
  MessageListParams,
  InferenceRequestParams,
  InferenceAbortParams,
  BranchCreateParams,
  BranchSwitchParams,
  BranchDeleteParams,
  AgentContextParams,
  ModuleStateParams,
  StoreInspectParams,
  StoreStatesParams,
  StoreSearchParams,
  StoreSubscribeParams,
  StoreUnsubscribeParams,
  InferenceTailParams,
  InferenceInspectParams,
  InferenceSearchParams,
  EventsTailParams,
  EventsInspectParams,
  EventsSearchParams,
  EventsSubscribeParams,
  PersistedEvent,
  AgentInfo,
  ModuleInfo,
  BranchInfo,
  StateInfo,
} from './types.js';

export * from './types.js';

const DEFAULT_CONFIG: Required<ApiServerConfig> = {
  port: 8765,
  host: 'localhost',
  path: '/ws',
  enableHttp: true,
};

/** Polling interval for subscriptions (ms) */
const SUBSCRIPTION_POLL_INTERVAL = 50;

/**
 * API Server for the agent framework.
 */
export class ApiServer {
  private config: Required<ApiServerConfig>;
  private framework: AgentFramework;
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private clients: Set<WebSocket> = new Set();
  private currentBranch = 'main';

  /** Map from client to their subscription IDs */
  private clientSubscriptions: Map<WebSocket, Set<string>> = new Map();
  /** Subscription poll interval timer */
  private subscriptionPollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(framework: AgentFramework, config: ApiServerConfig = {}) {
    this.framework = framework;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the API server.
   */
  async start(): Promise<void> {
    // Create HTTP server for both WebSocket upgrade and REST endpoints
    this.httpServer = createServer((req, res) => {
      if (this.config.enableHttp) {
        this.handleHttpRequest(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // Create WebSocket server
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: this.config.path,
    });

    this.wss.on('connection', (ws) => {
      this.handleConnection(ws);
    });

    // Subscribe to trace events
    this.framework.onTrace((event) => {
      this.handleTraceEvent(event);
    });

    // Start listening
    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.config.port, this.config.host, () => {
        console.log(
          `API server listening on ws://${this.config.host}:${this.config.port}${this.config.path}`
        );
        resolve();
      });
    });

    // Start subscription polling
    this.subscriptionPollInterval = setInterval(() => {
      this.pollSubscriptions();
    }, SUBSCRIPTION_POLL_INTERVAL);
  }

  /**
   * Stop the API server.
   */
  async stop(): Promise<void> {
    // Stop subscription polling
    if (this.subscriptionPollInterval) {
      clearInterval(this.subscriptionPollInterval);
      this.subscriptionPollInterval = null;
    }

    // Cleanup all subscriptions
    const store = this.framework.getStore();
    for (const [_, subscriptionIds] of this.clientSubscriptions) {
      for (const subId of subscriptionIds) {
        store.unsubscribe(subId);
      }
    }
    this.clientSubscriptions.clear();

    // Close all client connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    // Close servers
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  /**
   * Get the server URL.
   */
  get url(): string {
    return `ws://${this.config.host}:${this.config.port}${this.config.path}`;
  }

  // ==========================================================================
  // WebSocket Handling
  // ==========================================================================

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(ws, message);
      } catch (error) {
        this.sendResponse(ws, {
          type: 'response',
          success: false,
          error: 'Invalid JSON',
        });
      }
    });

    ws.on('close', () => {
      this.cleanupClientSubscriptions(ws);
      this.clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.cleanupClientSubscriptions(ws);
      this.clients.delete(ws);
    });

    // Send welcome event
    this.sendEvent(ws, 'connected', {
      currentBranch: this.currentBranch,
      agents: this.framework.getAllAgents().map((a) => a.name),
    });
  }

  private async handleClientMessage(
    ws: WebSocket,
    message: ApiRequest
  ): Promise<void> {
    if (message.type !== 'request') {
      this.sendResponse(ws, {
        type: 'response',
        id: message.id,
        success: false,
        error: 'Expected request message',
      });
      return;
    }

    try {
      const result = await this.executeCommand(ws, message.command, message.params);
      this.sendResponse(ws, {
        type: 'response',
        id: message.id,
        success: true,
        data: result,
      });
    } catch (error) {
      this.sendResponse(ws, {
        type: 'response',
        id: message.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sendResponse(ws: WebSocket, response: ApiResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  private sendEvent(ws: WebSocket, event: string, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      const message: ApiEvent = { type: 'event', event, data };
      ws.send(JSON.stringify(message));
    }
  }

  private broadcast(event: string, data: unknown): void {
    const message: ApiEvent = { type: 'event', event, data };
    const json = JSON.stringify(message);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  // ==========================================================================
  // Trace Event Handling
  // ==========================================================================

  private handleTraceEvent(event: TraceEvent): void {
    // Skip process:received — clients don't need raw input events
    if (event.type === 'process:received') {
      return;
    }

    // Broadcast all other trace events directly — no translation needed
    // TraceEvents are already serializable (error is string, not Error)
    this.broadcast(event.type, event);
  }

  // ==========================================================================
  // Command Execution
  // ==========================================================================

  private async executeCommand(
    ws: WebSocket,
    command: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    switch (command) {
      // Conversation
      case 'message.send':
        return this.cmdMessageSend(params as unknown as MessageSendParams);
      case 'message.list':
        return this.cmdMessageList(params as unknown as MessageListParams);
      case 'inference.request':
        return this.cmdInferenceRequest(params as unknown as InferenceRequestParams);
      case 'inference.abort':
        return this.cmdInferenceAbort(params as unknown as InferenceAbortParams);

      // Branching
      case 'branch.list':
        return this.cmdBranchList();
      case 'branch.create':
        return this.cmdBranchCreate(params as unknown as BranchCreateParams);
      case 'branch.switch':
        return this.cmdBranchSwitch(params as unknown as BranchSwitchParams);
      case 'branch.current':
        return this.cmdBranchCurrent();
      case 'branch.delete':
        return this.cmdBranchDelete(params as unknown as BranchDeleteParams);

      // Undo/Redo
      case 'undo':
        return this.cmdUndo(params as unknown as { agentName: string });
      case 'redo':
        return this.cmdRedo(params as unknown as { agentName: string });
      case 'undo.state':
        return this.cmdUndoState(params as unknown as { agentName: string });

      // Inspection
      case 'agent.list':
        return this.cmdAgentList();
      case 'agent.context':
        return this.cmdAgentContext(params as unknown as AgentContextParams);
      case 'module.list':
        return this.cmdModuleList();
      case 'module.state':
        return this.cmdModuleState(params as unknown as ModuleStateParams);
      case 'store.states':
        return this.cmdStoreStates(params as unknown as StoreStatesParams);
      case 'store.inspect':
        return this.cmdStoreInspect(params as unknown as StoreInspectParams);
      case 'store.search':
        return this.cmdStoreSearch(params as unknown as StoreSearchParams);

      // Subscriptions
      case 'store.subscribe':
        return this.cmdStoreSubscribe(ws, params as unknown as StoreSubscribeParams);
      case 'store.unsubscribe':
        return this.cmdStoreUnsubscribe(ws, params as unknown as StoreUnsubscribeParams);

      // Inference logs
      case 'inference.tail':
        return this.cmdInferenceTail(params as unknown as InferenceTailParams);
      case 'inference.inspect':
        return this.cmdInferenceInspect(params as unknown as InferenceInspectParams);
      case 'inference.search':
        return this.cmdInferenceSearch(params as unknown as InferenceSearchParams);

      // Event logs
      case 'events.tail':
        return this.cmdEventsTail(params as unknown as EventsTailParams);
      case 'events.inspect':
        return this.cmdEventsInspect(params as unknown as EventsInspectParams);
      case 'events.search':
        return this.cmdEventsSearch(params as unknown as EventsSearchParams);
      case 'events.subscribe':
        return this.cmdEventsSubscribe(params as unknown as EventsSubscribeParams);

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  // ==========================================================================
  // Conversation Commands
  // ==========================================================================

  private async cmdMessageSend(params: MessageSendParams): Promise<{ messageId: string }> {
    if (!params.participant || !params.content) {
      throw new Error('participant and content are required');
    }

    // Push api:message event for the ApiModule to handle
    this.framework.pushEvent({
      type: 'api:message',
      participant: params.participant,
      content: params.content,
      triggerInference: params.triggerInference ?? true,
      targetAgents: params.targetAgents,
    } as ProcessEvent);

    return { messageId: 'pending' }; // TODO: return actual ID
  }

  private async cmdMessageList(params?: MessageListParams): Promise<{ messages: unknown[] }> {
    // Get messages from first agent's context manager
    const agent = this.framework.getAllAgents()[0];
    if (!agent) {
      return { messages: [] };
    }

    const contextManager = agent.getContextManager();
    const { messages } = await contextManager.compile();

    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;

    return {
      messages: messages.slice(-(limit + offset), offset ? -offset : undefined),
    };
  }

  private async cmdInferenceRequest(params?: InferenceRequestParams): Promise<{ queued: boolean }> {
    // Push api:inference-request event for the ApiModule to handle
    this.framework.pushEvent({
      type: 'api:inference-request',
      agentName: params?.agentName,
      reason: params?.reason,
    } as ProcessEvent);

    return { queued: true };
  }

  private async cmdInferenceAbort(params?: InferenceAbortParams): Promise<{ aborted: boolean }> {
    if (!params?.agentName) {
      throw new Error('agentName is required');
    }

    const aborted = this.framework.abortInference(params.agentName, params.reason);
    return { aborted };
  }

  // ==========================================================================
  // Branch Commands
  // ==========================================================================

  private async cmdBranchList(): Promise<{ branches: BranchInfo[] }> {
    const store = this.framework.getStore();
    const branches = store.listBranches();

    return {
      branches: branches.map((branch) => ({
        name: branch.name,
        isCurrent: branch.name === this.currentBranch,
      })),
    };
  }

  private async cmdBranchCreate(params: BranchCreateParams): Promise<{ name: string }> {
    if (!params.name) {
      throw new Error('name is required');
    }

    const store = this.framework.getStore();
    store.createBranch(params.name);

    this.broadcast('branch:created', {
      name: params.name,
      parent: this.currentBranch,
    });

    this.framework.notifyBranchChanged('created', params.name, {
      parent: this.currentBranch,
      source: 'api',
    });

    if (params.switchTo) {
      await this.cmdBranchSwitch({ name: params.name });
    }

    return { name: params.name };
  }

  private async cmdBranchSwitch(params: BranchSwitchParams): Promise<{ switched: boolean }> {
    if (!params.name) {
      throw new Error('name is required');
    }

    const store = this.framework.getStore();
    const previousBranch = this.currentBranch;

    store.switchBranch(params.name);
    this.currentBranch = params.name;

    this.broadcast('branch:switched', {
      from: previousBranch,
      to: params.name,
    });

    this.framework.notifyBranchChanged('switched', params.name, {
      previous: previousBranch,
      source: 'api',
    });

    return { switched: true };
  }

  private async cmdBranchCurrent(): Promise<{ name: string }> {
    return { name: this.currentBranch };
  }

  private async cmdBranchDelete(params: BranchDeleteParams): Promise<{ deleted: boolean }> {
    if (!params.name) {
      throw new Error('name is required');
    }

    if (params.name === this.currentBranch) {
      throw new Error('Cannot delete current branch');
    }

    if (params.name === 'main') {
      throw new Error('Cannot delete main branch');
    }

    const store = this.framework.getStore();
    store.deleteBranch(params.name);

    this.broadcast('branch:deleted', { name: params.name });

    this.framework.notifyBranchChanged('deleted', params.name, { source: 'api' });

    return { deleted: true };
  }

  // ==========================================================================
  // Undo/Redo Commands
  // ==========================================================================

  private cmdUndo(params: { agentName: string }): unknown {
    if (!params.agentName) {
      throw new Error('agentName is required');
    }

    const result = this.framework.undoLastTurn(params.agentName);

    if (result.undone) {
      this.currentBranch = result.toBranch!;
      this.broadcast('branch:switched', {
        from: result.fromBranch,
        to: result.toBranch,
        reason: 'undo',
      });
    }

    return result;
  }

  private cmdRedo(params: { agentName: string }): unknown {
    if (!params.agentName) {
      throw new Error('agentName is required');
    }

    const result = this.framework.redo(params.agentName);

    if (result.redone) {
      this.currentBranch = result.toBranch!;
      this.broadcast('branch:switched', {
        from: result.fromBranch,
        to: result.toBranch,
        reason: 'redo',
      });
    }

    return result;
  }

  private cmdUndoState(params: { agentName: string }): unknown {
    if (!params.agentName) {
      throw new Error('agentName is required');
    }

    return this.framework.getUndoRedoState(params.agentName);
  }

  // ==========================================================================
  // Inspection Commands
  // ==========================================================================

  private async cmdAgentList(): Promise<{ agents: AgentInfo[] }> {
    const agents = this.framework.getAllAgents();

    return {
      agents: agents.map((a) => ({
        name: a.name,
        model: a.model,
        status: a.state.status,
        systemPromptPreview: a.systemPrompt.substring(0, 200) + '...',
        allowedTools: a.allowedTools,
      })),
    };
  }

  private async cmdAgentContext(params: AgentContextParams): Promise<{ context: unknown }> {
    if (!params.agentName) {
      throw new Error('agentName is required');
    }

    const agent = this.framework.getAgent(params.agentName);
    if (!agent) {
      throw new Error(`Agent not found: ${params.agentName}`);
    }

    const contextManager = agent.getContextManager();
    const { messages } = await contextManager.compile(
      params.maxTokens
        ? { maxTokens: params.maxTokens, reserveForResponse: 4096 }
        : undefined
    );

    return { context: messages };
  }

  private async cmdModuleList(): Promise<{ modules: ModuleInfo[] }> {
    const modules = this.framework.getAllModules();
    const allTools = this.framework.getAllTools();

    return {
      modules: modules.map((module) => ({
        name: module.name,
        tools: allTools
          .filter((t) => t.name.startsWith(`${module.name}:`))
          .map((t) => t.name),
      })),
    };
  }

  private async cmdModuleState(params: ModuleStateParams): Promise<{ state: unknown }> {
    if (!params.moduleName) {
      throw new Error('moduleName is required');
    }

    const store = this.framework.getStore();
    const stateId = `modules/${params.moduleName}/state`;
    const state = store.getStateJson(stateId);

    return { state };
  }

  private async cmdStoreStates(params?: StoreStatesParams): Promise<{ states: StateInfo[] }> {
    const store = this.framework.getStore();
    let stateInfos = store.listStates();

    // Filter by namespace
    if (params?.namespace) {
      stateInfos = stateInfos.filter((info) => info.id.startsWith(params.namespace!));
    }

    // Apply limit (default 50)
    const limit = params?.limit ?? 50;
    stateInfos = stateInfos.slice(-limit);

    return {
      states: stateInfos.map((info) => ({
        id: info.id,
        strategy: info.strategy,
        hasData: store.getStateJson(info.id) !== null,
      })),
    };
  }

  private async cmdStoreSearch(params?: StoreSearchParams): Promise<{ results: Array<{ stateId: string; preview: string }>; total: number; hasMore: boolean }> {
    const store = this.framework.getStore();
    let stateInfos = store.listStates();

    // Filter by namespace
    if (params?.namespace) {
      stateInfos = stateInfos.filter((info) => info.id.startsWith(params.namespace!));
    }

    const limit = params?.limit ?? 20;
    const offset = params?.offset ?? 0;
    const previewLength = params?.previewLength ?? 300;
    const pattern = params?.contentPattern ? new RegExp(params.contentPattern, 'i') : null;

    // Collect all matching results first (for accurate total count)
    const allMatches: Array<{ stateId: string; content: string }> = [];

    for (const info of stateInfos) {
      const data = store.getStateJson(info.id);
      if (data === null) continue;

      const content = JSON.stringify(data);

      // If pattern specified, filter by it
      if (pattern && !pattern.test(content)) continue;

      allMatches.push({ stateId: info.id, content });
    }

    // Apply pagination
    const paged = allMatches.slice(offset, offset + limit);
    const results = paged.map(({ stateId, content }) => ({
      stateId,
      preview: content.length > previewLength ? content.slice(0, previewLength) + '...' : content,
    }));

    return {
      results,
      total: allMatches.length,
      hasMore: offset + limit < allMatches.length,
    };
  }

  private async cmdStoreInspect(params: StoreInspectParams): Promise<{ data: unknown }> {
    if (!params.stateId) {
      throw new Error('stateId is required');
    }

    const store = this.framework.getStore();
    const data = store.getStateJson(params.stateId);

    return { data };
  }

  // ==========================================================================
  // Inference Log Commands
  // ==========================================================================

  private async cmdInferenceTail(params?: InferenceTailParams): Promise<{ entries: unknown[] }> {
    const entries = this.framework.tailInferenceLogs(
      params?.count ?? 10,
      params?.agentName
    );

    return { entries };
  }

  private async cmdInferenceInspect(params: InferenceInspectParams): Promise<{ entry: unknown }> {
    if (params.sequence === undefined || params.sequence === null) {
      throw new Error('sequence is required');
    }

    const entry = this.framework.getInferenceLog(params.sequence);
    if (!entry) {
      throw new Error(`Inference log not found: ${params.sequence}`);
    }

    return { entry };
  }

  private async cmdInferenceSearch(params?: InferenceSearchParams): Promise<unknown> {
    const result = this.framework.queryInferenceLogs({
      agentName: params?.agentName,
      limit: params?.limit,
      offset: params?.offset,
      pattern: params?.pattern,
      errorsOnly: params?.errorsOnly,
    });

    return result;
  }

  // ==========================================================================
  // Event Log Commands
  // ==========================================================================

  private async cmdEventsTail(params?: EventsTailParams): Promise<{ entries: unknown[] }> {
    const entries = this.framework.tailProcessLogs(
      params?.count ?? 10,
      params?.eventType
    );

    return { entries };
  }

  private async cmdEventsInspect(params: EventsInspectParams): Promise<{ entry: unknown }> {
    if (params.sequence === undefined || params.sequence === null) {
      throw new Error('sequence is required');
    }

    const entry = this.framework.getProcessLog(params.sequence);
    if (!entry) {
      throw new Error(`Process log not found: ${params.sequence}`);
    }

    return { entry };
  }

  private async cmdEventsSearch(params?: EventsSearchParams): Promise<unknown> {
    const result = this.framework.queryProcessLogs({
      eventType: params?.eventType,
      moduleName: params?.moduleName,
      limit: params?.limit,
      offset: params?.offset,
      pattern: params?.pattern,
    });

    return result;
  }

  private async cmdEventsSubscribe(
    params?: EventsSubscribeParams
  ): Promise<{ subscribed: string[]; history: PersistedEvent[] }> {
    const types = params?.types ?? ['*'];
    const limit = params?.limit ?? 100;

    // Get historical events from the process log
    const processEntries = this.framework.tailProcessLogs(limit);

    // Convert ProcessLogEntry to PersistedEvent format
    const history: PersistedEvent[] = processEntries.map((item) => {
      const { sequence, entry } = item;
      const event = entry.processEvent;
      const timestamp = entry.timestamp;

      // Extract agent/module info from event if available
      const agentName =
        (event as Record<string, unknown>).agentName as string | undefined;
      const moduleName =
        (event as Record<string, unknown>).moduleName as string | undefined;

      return {
        id: `evt-${sequence}`,
        sequence,
        timestamp,
        type: event?.type ?? 'unknown',
        payload: event,
        source: 'chronicle',
        agentName,
        moduleName,
      };
    });

    // Filter by types if not wildcard
    const filteredHistory =
      types.includes('*')
        ? history
        : history.filter((evt) =>
            types.some((pattern) => matchEventType(pattern, evt.type))
          );

    return {
      subscribed: types,
      history: filteredHistory,
    };
  }

  // ==========================================================================
  // HTTP Handling (optional REST endpoints)
  // ==========================================================================

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', branch: this.currentBranch }));
      return;
    }

    // Status
    if (url.pathname === '/status') {
      const agents = this.framework.getAllAgents();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          branch: this.currentBranch,
          agents: agents.map((a) => ({ name: a.name, status: a.state.status })),
          clients: this.clients.size,
          queueDepth: this.framework.getQueueDepth(),
        })
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ==========================================================================
  // Subscription Commands
  // ==========================================================================

  private async cmdStoreSubscribe(
    ws: WebSocket,
    params?: StoreSubscribeParams
  ): Promise<{ subscriptionId: string }> {
    const store = this.framework.getStore();

    // Build subscription config
    const config: {
      bufferSize?: number;
      maxSnapshotBytes?: number;
      fromSequence?: number;
      filter?: {
        recordTypes?: string[];
        branch?: string;
        stateIds?: string[];
        includeRecords?: boolean;
        includeStateChanges?: boolean;
        includeBranchEvents?: boolean;
      };
    } = {};

    if (params?.bufferSize !== undefined) {
      config.bufferSize = params.bufferSize;
    }
    if (params?.maxSnapshotBytes !== undefined) {
      config.maxSnapshotBytes = params.maxSnapshotBytes;
    }
    if (params?.fromSequence !== undefined) {
      config.fromSequence = params.fromSequence;
    }
    if (params?.filter) {
      config.filter = {
        recordTypes: params.filter.recordTypes,
        branch: params.filter.branch,
        stateIds: params.filter.stateIds,
        includeRecords: params.filter.includeRecords ?? false,
        includeStateChanges: params.filter.includeStateChanges ?? false,
        includeBranchEvents: params.filter.includeBranchEvents ?? false,
      };
    }

    // Create subscription
    const subscriptionId = store.subscribe(config);

    // Track this subscription for the client
    if (!this.clientSubscriptions.has(ws)) {
      this.clientSubscriptions.set(ws, new Set());
    }
    this.clientSubscriptions.get(ws)!.add(subscriptionId);

    // If fromSequence is set, perform catch-up
    if (params?.fromSequence !== undefined) {
      store.catchUpSubscription(subscriptionId);
    } else {
      // Mark as caught up immediately for live-only subscriptions
      // The store will send the CaughtUp event
      store.catchUpSubscription(subscriptionId);
    }

    return { subscriptionId };
  }

  private async cmdStoreUnsubscribe(
    ws: WebSocket,
    params: StoreUnsubscribeParams
  ): Promise<{ success: boolean }> {
    if (!params.subscriptionId) {
      throw new Error('subscriptionId is required');
    }

    const store = this.framework.getStore();

    // Remove from client tracking
    const clientSubs = this.clientSubscriptions.get(ws);
    if (clientSubs) {
      clientSubs.delete(params.subscriptionId);
    }

    // Unsubscribe from store
    store.unsubscribe(params.subscriptionId);

    return { success: true };
  }

  // ==========================================================================
  // Subscription Helpers
  // ==========================================================================

  /**
   * Cleanup all subscriptions for a disconnected client.
   */
  private cleanupClientSubscriptions(ws: WebSocket): void {
    const subscriptionIds = this.clientSubscriptions.get(ws);
    if (!subscriptionIds) return;

    const store = this.framework.getStore();
    for (const subId of subscriptionIds) {
      store.unsubscribe(subId);
    }

    this.clientSubscriptions.delete(ws);
  }

  /**
   * Poll all active subscriptions and push events to clients.
   */
  private pollSubscriptions(): void {
    const store = this.framework.getStore();

    for (const [ws, subscriptionIds] of this.clientSubscriptions) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      for (const subId of subscriptionIds) {
        // Poll events from this subscription (non-blocking)
        let event = store.pollSubscription(subId);
        let eventCount = 0;
        const maxEventsPerPoll = 100; // Prevent blocking too long

        while (event && eventCount < maxEventsPerPoll) {
          // Parse the event data and send to client
          try {
            const eventData = JSON.parse(event.data);
            const eventType = `store:${event.eventType}`;

            this.sendEvent(ws, eventType, {
              subscriptionId: subId,
              ...eventData,
            });
          } catch (error) {
            console.error('Failed to parse subscription event:', error);
          }

          // Check for more events
          event = store.pollSubscription(subId);
          eventCount++;
        }
      }
    }
  }
}

/**
 * Check if an event type matches a pattern.
 * Supports wildcards like 'inference:*' or exact matches.
 */
function matchEventType(pattern: string, eventType: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1);
    return eventType.startsWith(prefix);
  }
  return pattern === eventType;
}
