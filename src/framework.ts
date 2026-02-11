import { JsStore } from 'chronicle';
import type { Membrane, ContentBlock, YieldingStream, ToolResult as MembraneToolResult } from 'membrane';
import { ContextManager, PassthroughStrategy } from '@connectome/context-manager';
import type {
  MessageId,
  MessageMetadata,
  MessageQuery,
  MessageQueryResult,
  StoredMessage,
} from '@connectome/context-manager';
import type {
  FrameworkConfig,
  InferencePolicy,
  ErrorPolicy,
  ErrorAction,
  FrameworkState,
  TraceEvent,
  TraceEventListener,
  InferenceLogEntry,
  InferenceLogQuery,
  InferenceLogQueryResult,
  InferenceLogEntryWithId,
  InferenceLogSummary,
  ProcessLogEntry,
  ProcessLogQuery,
  ProcessLogQueryResult,
  ProcessLogEntryWithId,
  ProcessLogSummary,
  ProcessEvent,
  EventResponse,
  ModuleProcessResponse,
  ToolCall,
  ToolResult,
  AgentConfig,
  InferenceRequest,
  AgentState,
  Module,
} from './types/index.js';
import { ProcessQueueImpl } from './queue.js';
import { Agent } from './agent.js';
import { ModuleRegistry } from './module-registry.js';

const FRAMEWORK_STATE_ID = 'framework/state';
const INFERENCE_LOG_ID = 'framework/inference-log';
const PROCESS_LOG_ID = 'framework/process-log';

/**
 * Default inference policy - infer if any request exists for the agent.
 */
class DefaultInferencePolicy implements InferencePolicy {
  shouldInfer(
    agentName: string,
    requests: InferenceRequest[],
    _state: FrameworkState
  ): boolean {
    return requests.some((r) => r.agentName === agentName);
  }
}

/**
 * Default error policy - retry with exponential backoff.
 */
class DefaultErrorPolicy implements ErrorPolicy {
  maxRetries = 3;

  onInferenceError(error: Error, _agentName: string, attempt: number): ErrorAction {
    if (attempt < this.maxRetries) {
      return { retry: true, delayMs: Math.pow(2, attempt) * 1000 };
    }
    return { retry: false };
  }
}

/** Default sync interval in milliseconds */
const DEFAULT_SYNC_INTERVAL_MS = 1000;

/**
 * The main agent framework.
 */
export class AgentFramework {
  private store: JsStore;
  private ownsStore: boolean;
  private membrane: Membrane;
  private queue: ProcessQueueImpl;
  private agents: Map<string, Agent> = new Map();
  private moduleRegistry: ModuleRegistry;
  private inferencePolicy: InferencePolicy;
  private errorPolicy: ErrorPolicy;
  private pendingRequests: InferenceRequest[] = [];
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private traceListeners: TraceEventListener[] = [];
  private syncIntervalMs: number;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private processLoggingPersist: boolean;
  private processLoggingBroadcast: boolean;
  private activeStreams: Map<string, Promise<void>> = new Map();

  private constructor(
    store: JsStore,
    ownsStore: boolean,
    membrane: Membrane,
    inferencePolicy: InferencePolicy,
    errorPolicy: ErrorPolicy,
    syncIntervalMs: number,
    processLoggingPersist: boolean,
    processLoggingBroadcast: boolean
  ) {
    this.store = store;
    this.ownsStore = ownsStore;
    this.membrane = membrane;
    this.inferencePolicy = inferencePolicy;
    this.errorPolicy = errorPolicy;
    this.syncIntervalMs = syncIntervalMs;
    this.processLoggingPersist = processLoggingPersist;
    this.processLoggingBroadcast = processLoggingBroadcast;
    this.queue = new ProcessQueueImpl();

    // Initialize module registry with callbacks
    this.moduleRegistry = new ModuleRegistry(store, this.queue, {
      getAgents: () => Array.from(this.agents.values()),
      addMessage: (p, c, m) => this.addMessage(p, c, m),
      editMessage: (id, c) => this.editMessage(id, c),
      removeMessage: (id) => this.removeMessage(id),
      getMessage: (id) => this.getMessage(id),
      queryMessages: (filter) => this.queryMessages(filter),
      pushEvent: (event) => this.pushEvent(event),
    });
  }

  /**
   * Create and start the framework.
   */
  static async create(config: FrameworkConfig): Promise<AgentFramework> {
    // Create or use existing store
    let store: JsStore;
    let ownsStore: boolean;

    if (config.store) {
      store = config.store;
      ownsStore = false;
    } else if (config.storePath) {
      store = JsStore.openOrCreate({ path: config.storePath });
      ownsStore = true;
    } else {
      throw new Error('Either storePath or store must be provided');
    }

    // Register framework states
    try {
      store.registerState({ id: FRAMEWORK_STATE_ID, strategy: 'snapshot' });
    } catch {
      // Already registered
    }

    try {
      store.registerState({
        id: INFERENCE_LOG_ID,
        strategy: 'append_log',
        deltaSnapshotEvery: 100,
        fullSnapshotEvery: 20,
      });
    } catch {
      // Already registered
    }

    // Process logging config (default: disabled)
    const processLoggingPersist = config.processLogging?.persist ?? false;
    const processLoggingBroadcast = config.processLogging?.broadcast ?? false;

    // Register process log state only if persistence is enabled
    if (processLoggingPersist) {
      try {
        store.registerState({
          id: PROCESS_LOG_ID,
          strategy: 'append_log',
          deltaSnapshotEvery: 100,
          fullSnapshotEvery: 20,
        });
      } catch {
        // Already registered
      }
    }

    const framework = new AgentFramework(
      store,
      ownsStore,
      config.membrane,
      config.inferencePolicy ?? new DefaultInferencePolicy(),
      config.errorPolicy ?? new DefaultErrorPolicy(),
      config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
      processLoggingPersist,
      processLoggingBroadcast
    );

    // Create agents
    for (const agentConfig of config.agents) {
      await framework.createAgent(agentConfig);
    }

    // Add modules
    for (const module of config.modules) {
      await framework.addModule(module);
    }

    return framework;
  }

  /**
   * Start the event loop.
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loopPromise = this.runLoop();

    // Start periodic sync timer (if enabled)
    if (this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        try {
          this.store.sync();
        } catch (error) {
          console.error('Periodic sync error:', error);
        }
      }, this.syncIntervalMs);
    }
  }

  /**
   * Stop the event loop.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.queue.close();

    // Cancel all active streams
    for (const agent of this.agents.values()) {
      if (agent.state.status === 'streaming' ||
          (agent.state.status === 'waiting_for_tools' && agent.state.stream)) {
        agent.cancelStream();
      }
    }

    // Wait for all stream iteration handles to settle
    if (this.activeStreams.size > 0) {
      await Promise.allSettled(this.activeStreams.values());
    }

    // Stop sync timer
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.loopPromise) {
      await this.loopPromise;
    }

    await this.moduleRegistry.stopAll();

    // Final sync before closing
    try {
      this.store.sync();
    } catch (error) {
      console.error('Final sync error:', error);
    }

    if (this.ownsStore) {
      this.store.close();
    }
  }

  /**
   * Push a process event to the queue.
   */
  pushEvent(event: ProcessEvent): void {
    this.queue.push(event);
    this.emitTrace({ type: 'process:received', processEvent: event });
  }

  /**
   * Add a trace event listener for observability.
   */
  onTrace(listener: TraceEventListener): void {
    this.traceListeners.push(listener);
  }

  /**
   * Remove a trace event listener.
   */
  offTrace(listener: TraceEventListener): void {
    const index = this.traceListeners.indexOf(listener);
    if (index >= 0) {
      this.traceListeners.splice(index, 1);
    }
  }

  /**
   * Add a module at runtime.
   */
  async addModule(module: Module): Promise<void> {
    await this.moduleRegistry.addModule(module);
    this.emitTrace({ type: 'module:added', moduleName: module.name });
  }

  /**
   * Remove a module at runtime.
   */
  async removeModule(name: string): Promise<void> {
    await this.moduleRegistry.removeModule(name);
    this.emitTrace({ type: 'module:removed', moduleName: name });
  }

  /**
   * Get an agent by name.
   */
  getAgent(name: string): Agent | null {
    return this.agents.get(name) ?? null;
  }

  /**
   * Get all agents.
   */
  getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get all registered modules.
   */
  getAllModules(): Module[] {
    return this.moduleRegistry.getAllModules();
  }

  /**
   * Get all available tools from all modules.
   */
  getAllTools(): import('./types/index.js').ToolDefinition[] {
    return this.moduleRegistry.getAllTools();
  }

  /**
   * Check if process logging is enabled.
   */
  isProcessLoggingEnabled(): { persist: boolean; broadcast: boolean } {
    return {
      persist: this.processLoggingPersist,
      broadcast: this.processLoggingBroadcast,
    };
  }

  /**
   * Get the underlying store.
   */
  getStore(): JsStore {
    return this.store;
  }

  /**
   * Get queue depth.
   */
  getQueueDepth(): number {
    return this.queue.depth;
  }

  /**
   * Query inference logs.
   * Returns entries with summary info (doesn't resolve blobs).
   */
  queryInferenceLogs(query?: InferenceLogQuery): InferenceLogQueryResult {
    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const pattern = query?.pattern ? new RegExp(query.pattern, 'i') : null;

    // Get all entries from the append log
    const allEntries: InferenceLogEntryWithId[] = [];
    const stateInfo = this.store.listStates().find((s) => s.id === INFERENCE_LOG_ID);

    if (stateInfo) {
      // Query the append log - get raw data
      const data = this.store.getStateJson(INFERENCE_LOG_ID);
      if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
          const entry = data[i] as InferenceLogEntry;

          // Build summary (without resolving blobs)
          const requestIsBlob = !!(entry.request && typeof entry.request === 'object' && 'blobId' in entry.request);
          const responseIsBlob = !!(entry.response && typeof entry.response === 'object' && 'blobId' in entry.response);

          const summary: InferenceLogSummary = {
            timestamp: entry.timestamp,
            agentName: entry.agentName,
            requestId: entry.requestId,
            success: entry.success,
            error: entry.error,
            durationMs: entry.durationMs,
            tokenUsage: entry.tokenUsage,
            stopReason: entry.stopReason,
            requestIsBlob,
            responseIsBlob,
          };

          allEntries.push({ sequence: i, entry, summary });
        }
      }
    }

    // Filter entries
    let filtered = allEntries;

    if (query?.agentName) {
      filtered = filtered.filter((e) => e.entry.agentName === query.agentName);
    }

    if (query?.errorsOnly) {
      filtered = filtered.filter((e) => !e.entry.success);
    }

    if (pattern) {
      filtered = filtered.filter((e) => {
        // Search in summary fields only (not blob content)
        const content = JSON.stringify(e.summary);
        return pattern.test(content);
      });
    }

    // Reverse to get most recent first
    filtered = filtered.reverse();

    // Paginate
    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    return {
      entries: paged,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get a specific inference log entry by sequence number.
   * Resolves blob references to full content.
   */
  getInferenceLog(sequence: number, resolveBlobs = true): InferenceLogEntryWithId | null {
    const data = this.store.getStateJson(INFERENCE_LOG_ID);
    if (Array.isArray(data) && sequence >= 0 && sequence < data.length) {
      const entry = data[sequence] as InferenceLogEntry;

      if (resolveBlobs) {
        // Resolve blob references
        const resolved = { ...entry };

        if (entry.request && typeof entry.request === 'object' && 'blobId' in entry.request) {
          const blob = this.store.getBlob((entry.request as { blobId: string }).blobId);
          if (blob) {
            try {
              resolved.request = JSON.parse(blob.toString());
            } catch {
              resolved.request = { error: 'Failed to parse blob', blobId: (entry.request as { blobId: string }).blobId };
            }
          }
        }

        if (entry.response && typeof entry.response === 'object' && 'blobId' in entry.response) {
          const blob = this.store.getBlob((entry.response as { blobId: string }).blobId);
          if (blob) {
            try {
              resolved.response = JSON.parse(blob.toString());
            } catch {
              resolved.response = { error: 'Failed to parse blob', blobId: (entry.response as { blobId: string }).blobId };
            }
          }
        }

        return { sequence, entry: resolved };
      }

      return { sequence, entry };
    }
    return null;
  }

  /**
   * Get the most recent inference logs (tail).
   */
  tailInferenceLogs(count = 10, agentName?: string): InferenceLogEntryWithId[] {
    const result = this.queryInferenceLogs({
      limit: count,
      agentName,
    });
    return result.entries;
  }

  /**
   * Query process logs.
   * Returns entries with summary info (doesn't resolve blobs).
   */
  queryProcessLogs(query?: ProcessLogQuery): ProcessLogQueryResult {
    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const pattern = query?.pattern ? new RegExp(query.pattern, 'i') : null;

    const allEntries: ProcessLogEntryWithId[] = [];
    const stateInfo = this.store.listStates().find((s) => s.id === PROCESS_LOG_ID);

    if (stateInfo) {
      const data = this.store.getStateJson(PROCESS_LOG_ID);
      if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
          const entry = data[i] as ProcessLogEntry;

          // Build summary
          const responsesIsBlob = !!(
            entry.responses &&
            typeof entry.responses === 'object' &&
            'blobId' in entry.responses
          );

          // Extract summary info from responses if not a blob
          let moduleCount = 0;
          const modulesRequestingInference: string[] = [];
          const modulesAddingMessages: string[] = [];

          if (!responsesIsBlob && Array.isArray(entry.responses)) {
            moduleCount = entry.responses.length;
            for (const { moduleName, response } of entry.responses) {
              if (response.requestInference) {
                modulesRequestingInference.push(moduleName);
              }
              if (response.addMessages?.length) {
                modulesAddingMessages.push(moduleName);
              }
            }
          }

          const summary: ProcessLogSummary = {
            timestamp: entry.timestamp,
            eventType: entry.processEvent.type,
            moduleCount,
            modulesRequestingInference,
            modulesAddingMessages,
            responsesIsBlob,
          };

          allEntries.push({ sequence: i, entry, summary });
        }
      }
    }

    // Filter entries
    let filtered = allEntries;

    if (query?.eventType) {
      filtered = filtered.filter((e) => e.entry.processEvent.type === query.eventType);
    }

    if (query?.moduleName) {
      filtered = filtered.filter((e) => {
        if (e.summary?.responsesIsBlob) return false;
        const responses = e.entry.responses as ModuleProcessResponse[];
        return responses.some((r) => r.moduleName === query.moduleName);
      });
    }

    if (pattern) {
      filtered = filtered.filter((e) => {
        const content = JSON.stringify(e.summary);
        return pattern.test(content);
      });
    }

    // Reverse to get most recent first
    filtered = filtered.reverse();

    // Paginate
    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    return {
      entries: paged,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get a specific process log entry by sequence number.
   * Resolves blob references to full content.
   */
  getProcessLog(sequence: number, resolveBlobs = true): ProcessLogEntryWithId | null {
    const data = this.store.getStateJson(PROCESS_LOG_ID);
    if (Array.isArray(data) && sequence >= 0 && sequence < data.length) {
      const entry = data[sequence] as ProcessLogEntry;

      if (resolveBlobs && entry.responses && typeof entry.responses === 'object' && 'blobId' in entry.responses) {
        const resolved = { ...entry };
        const blob = this.store.getBlob((entry.responses as { blobId: string }).blobId);
        if (blob) {
          try {
            resolved.responses = JSON.parse(blob.toString());
          } catch {
            resolved.responses = [];
          }
        }
        return { sequence, entry: resolved };
      }

      return { sequence, entry };
    }
    return null;
  }

  /**
   * Get the most recent process logs (tail).
   */
  tailProcessLogs(count = 10, eventType?: string): ProcessLogEntryWithId[] {
    const result = this.queryProcessLogs({
      limit: count,
      eventType,
    });
    return result.entries;
  }

  /**
   * Run until the queue is empty and all agents are idle.
   * Useful for testing.
   */
  async runUntilIdle(): Promise<void> {
    while (
      !this.queue.isEmpty ||
      this.activeStreams.size > 0 ||
      Array.from(this.agents.values()).some((a) => a.state.status !== 'idle')
    ) {
      await this.processNextEvent();
    }
  }

  private async createAgent(config: AgentConfig): Promise<Agent> {
    // Create context manager for this agent
    const contextManager = await ContextManager.open({
      store: this.store,
      namespace: `agents/${config.name}`,
      strategy: config.strategy ?? new PassthroughStrategy(),
      membrane: this.membrane,
    });

    const agent = new Agent(config, contextManager, this.membrane);
    this.agents.set(config.name, agent);

    return agent;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.processNextEvent();
      } catch (error) {
        console.error('Error in event loop:', error);
      }
    }
  }

  private async processNextEvent(): Promise<void> {
    // Try to get next process event (with timeout to check running flag)
    const event = this.queue.tryPop();

    if (event) {
      await this.handleProcessEvent(event);
    }

    // Check for inference requests
    await this.processInferenceRequests();

    // Yield to the event loop between iterations.
    // Full 10ms sleep when truly idle; minimal yield when streams are active
    // (needed to let stream microtasks and tool-call callbacks execute).
    if (!event && this.pendingRequests.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    } else if (this.activeStreams.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private async handleProcessEvent(event: ProcessEvent): Promise<void> {
    const startTime = Date.now();

    // Dispatch to all modules, tracking responses with module names
    const responses: ModuleProcessResponse[] = [];
    for (const module of this.moduleRegistry.getAllModules()) {
      try {
        const processState = this.moduleRegistry.createProcessState(module.name);
        const response = await module.onProcess(event, processState);
        responses.push({ moduleName: module.name, response });
      } catch (error) {
        console.error(`Module ${module.name} error handling process event:`, error);
      }
    }

    // Apply responses
    for (const { moduleName, response } of responses) {
      await this.applyProcessResponse(response, event, moduleName);
    }

    // Handle tool results specially
    if (event.type === 'tool-result') {
      const agent = this.agents.get(event.agentName);
      if (agent && agent.state.status === 'waiting_for_tools') {
        agent.provideToolResult(event.callId, event.result);

        // Check if agent is now ready (state may have changed after provideToolResult)
        // Cast to AgentState to bypass TypeScript's control flow narrowing
        const currentState = agent.state as AgentState;
        if (currentState.status === 'ready') {
          if (currentState.stream) {
            // Streaming path: convert results and resume the stream
            const membraneResults = currentState.toolResults.map(tc =>
              this.toMembraneToolResult(tc.id, tc.result)
            );
            currentState.stream.provideToolResults(membraneResults);
            agent.setStreaming(currentState.stream);
            this.emitTrace({ type: 'inference:stream_resumed', agentName: agent.name });
          } else {
            // Non-streaming fallback: schedule re-inference
            this.pendingRequests.push({
              agentName: agent.name,
              reason: 'tool_results_ready',
              source: 'framework',
              timestamp: Date.now(),
            });
          }
        }
      }
    }

    const durationMs = Date.now() - startTime;

    // Always emit trace for observability (UI needs this)
    this.emitTrace({ type: 'process:completed', processEvent: event, responses, durationMs });

    // Log to Chronicle (if enabled)
    if (this.processLoggingPersist) {
      this.logProcessEvent(event, responses);
    }
  }

  private async applyProcessResponse(
    response: EventResponse,
    event: ProcessEvent,
    moduleName: string
  ): Promise<void> {
    // Add messages
    if (response.addMessages) {
      for (const msg of response.addMessages) {
        const id = this.addMessage(msg.participant, msg.content, msg.metadata);
        this.emitTrace({ type: 'message:added', messageId: id, source: event.type });
      }
    }

    // Edit messages
    if (response.editMessages) {
      for (const edit of response.editMessages) {
        this.editMessage(edit.messageId, edit.content);
      }
    }

    // Remove messages
    if (response.removeMessages) {
      for (const id of response.removeMessages) {
        this.removeMessage(id);
      }
    }

    // Apply module state update atomically with message operations
    if (response.stateUpdate !== undefined) {
      this.moduleRegistry.setModuleState(moduleName, response.stateUpdate);
    }

    // Queue inference requests
    if (response.requestInference) {
      const source = 'source' in event ? (event as { source: string }).source : 'unknown';
      const targetAgents =
        response.requestInference === true
          ? Array.from(this.agents.keys())
          : response.requestInference;

      for (const agentName of targetAgents) {
        const agent = this.agents.get(agentName);
        if (agent && agent.canBeTriggeredBy(source)) {
          this.pendingRequests.push({
            agentName,
            reason: event.type,
            source,
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  private async processInferenceRequests(): Promise<void> {
    if (this.pendingRequests.length === 0) {
      return;
    }

    const state = this.createFrameworkState();

    // Group requests by agent
    const requestsByAgent = new Map<string, InferenceRequest[]>();
    for (const req of this.pendingRequests) {
      const existing = requestsByAgent.get(req.agentName) ?? [];
      existing.push(req);
      requestsByAgent.set(req.agentName, existing);
    }

    // Clear pending (we'll re-add if inference doesn't run)
    this.pendingRequests = [];

    // Check each agent
    for (const [agentName, requests] of requestsByAgent) {
      const agent = this.agents.get(agentName);
      if (!agent) continue;

      // Skip if agent is busy (inferring, streaming, or waiting for tools)
      if (agent.state.status === 'inferring' || agent.state.status === 'streaming' || agent.state.status === 'waiting_for_tools') {
        // Re-queue requests
        this.pendingRequests.push(...requests);
        continue;
      }

      // Check policy
      if (!this.inferencePolicy.shouldInfer(agentName, requests, state)) {
        continue;
      }

      // Start streaming inference (non-blocking — driveStream runs in background)
      const trigger = requests[0];
      await this.startAgentStream(agent, trigger);
    }
  }

  private async startAgentStream(agent: Agent, trigger?: InferenceRequest, attempt = 0): Promise<void> {
    this.emitTrace({ type: 'inference:started', agentName: agent.name });

    try {
      const tools = this.moduleRegistry.getAllTools().filter((t) => agent.canUseTool(t.name));
      const stream = await agent.startStream(tools);

      const handle = this.driveStream(agent, stream, trigger, attempt);
      this.activeStreams.set(agent.name, handle);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitTrace({
        type: 'inference:failed',
        agentName: agent.name,
        error: err.message,
        stack: err.stack,
      });
      agent.reset();

      const action = this.errorPolicy.onInferenceError(err, agent.name, attempt);
      if (action.retry) {
        await new Promise((resolve) => setTimeout(resolve, action.delayMs));
        await this.startAgentStream(agent, trigger, attempt + 1);
      } else if (action.emit) {
        this.pushEvent(action.emit);
      }
    }
  }

  private async driveStream(
    agent: Agent,
    stream: YieldingStream,
    trigger?: InferenceRequest,
    attempt = 0
  ): Promise<void> {
    const startTime = Date.now();
    const requestId = `${agent.name}-${startTime}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'tokens':
            this.emitTrace({
              type: 'inference:tokens',
              agentName: agent.name,
              content: event.content,
            });
            break;

          case 'tool-calls':
            this.emitTrace({
              type: 'inference:tool_calls_yielded',
              agentName: agent.name,
              calls: event.calls.map((c) => ({ id: c.id, name: c.name })),
            });
            agent.enterWaitingForTools(event.calls, stream);
            // Dispatch each tool call (async, results come back via ToolResultEvent)
            for (const call of event.calls) {
              this.dispatchToolCall(agent.name, call);
            }
            // Stream's async iterator blocks on next() until provideToolResults() is called
            break;

          case 'complete': {
            const durationMs = Date.now() - startTime;
            const response = event.response;

            // Add assistant response to context
            agent.addAssistantResponse(response.content);

            // Extract speech content
            const speechContent = response.content.filter(
              (block: ContentBlock): block is ContentBlock & { type: 'text' } =>
                block.type === 'text'
            );

            const tokenUsage = response.usage
              ? { input: response.usage.inputTokens, output: response.usage.outputTokens }
              : undefined;
            this.emitTrace({
              type: 'inference:completed',
              agentName: agent.name,
              durationMs,
              tokenUsage,
            });

            // Log inference
            this.logInference({
              timestamp: startTime,
              agentName: agent.name,
              requestId,
              success: true,
              request: { note: 'streaming request' },
              response: response.raw ?? { note: 'streaming response' },
              durationMs,
              tokenUsage,
              stopReason: response.stopReason,
            });

            // Dispatch speech
            if (speechContent.length > 0) {
              const speechContext = {
                turnComplete: true,
                trigger: trigger ?? {
                  reason: 'unknown',
                  source: 'unknown',
                  timestamp: Date.now(),
                },
              };
              await this.moduleRegistry.dispatchSpeech(
                agent.name,
                speechContent,
                speechContext
              );
            }

            // Done — reset to idle
            agent.reset();
            break;
          }

          case 'error': {
            const err = event.error;
            const durationMs = Date.now() - startTime;
            this.emitTrace({
              type: 'inference:failed',
              agentName: agent.name,
              error: err.message,
              stack: err.stack,
            });

            this.logInference({
              timestamp: startTime,
              agentName: agent.name,
              requestId,
              success: false,
              error: err.message,
              request: { note: 'streaming request failed' },
              durationMs,
            });

            agent.reset();

            const action = this.errorPolicy.onInferenceError(err, agent.name, attempt);
            if (action.retry) {
              await new Promise((resolve) => setTimeout(resolve, action.delayMs));
              await this.startAgentStream(agent, trigger, attempt + 1);
            } else if (action.emit) {
              this.pushEvent(action.emit);
            }
            break;
          }

          case 'aborted':
            agent.reset();
            break;

          case 'usage':
            // Token count updates — could emit trace for UI
            break;
        }
      }
    } catch (error) {
      // Stream itself threw (unexpected)
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitTrace({
        type: 'inference:failed',
        agentName: agent.name,
        error: err.message,
        stack: err.stack,
      });
      agent.reset();
    } finally {
      this.activeStreams.delete(agent.name);
    }
  }

  private toMembraneToolResult(callId: string, afResult: ToolResult): MembraneToolResult {
    return {
      toolUseId: callId,
      content: afResult.isError
        ? (afResult.error ?? 'Unknown error')
        : JSON.stringify(afResult.data),
      isError: afResult.isError,
    };
  }

  private logInference(entry: InferenceLogEntry): void {
    // Store large request/response as blobs
    const entryToStore = { ...entry };

    // Blob threshold: 10KB - typical context-heavy requests exceed this
    const BLOB_THRESHOLD = 10000;

    if (entry.request && typeof entry.request === 'object') {
      const requestJson = JSON.stringify(entry.request);
      if (requestJson.length > BLOB_THRESHOLD) {
        const blobId = this.store.storeBlob(Buffer.from(requestJson), 'application/json');
        entryToStore.request = { blobId };
      }
    }

    if (entry.response && typeof entry.response === 'object') {
      const responseJson = JSON.stringify(entry.response);
      if (responseJson.length > BLOB_THRESHOLD) {
        const blobId = this.store.storeBlob(Buffer.from(responseJson), 'application/json');
        entryToStore.response = { blobId };
      }
    }

    // Append to the inference log state
    const data = this.store.getStateJson(INFERENCE_LOG_ID);
    const entries = Array.isArray(data) ? data : [];
    entries.push(entryToStore);
    this.store.setStateJson(INFERENCE_LOG_ID, entries);
  }

  private logProcessEvent(event: ProcessEvent, responses: ModuleProcessResponse[]): void {
    const entry: ProcessLogEntry = {
      timestamp: Date.now(),
      processEvent: event,
      responses,
    };

    // Blob threshold: 10KB
    const BLOB_THRESHOLD = 10000;

    const entryToStore = { ...entry };
    const responsesJson = JSON.stringify(responses);
    if (responsesJson.length > BLOB_THRESHOLD) {
      const blobId = this.store.storeBlob(Buffer.from(responsesJson), 'application/json');
      entryToStore.responses = { blobId };
    }

    // Append to the process log state
    const data = this.store.getStateJson(PROCESS_LOG_ID);
    const entries = Array.isArray(data) ? data : [];
    entries.push(entryToStore);
    this.store.setStateJson(PROCESS_LOG_ID, entries);
  }

  private dispatchToolCall(agentName: string, call: ToolCall): void {
    const colonIndex = call.name.indexOf(':');
    const moduleName = colonIndex >= 0 ? call.name.substring(0, colonIndex) : 'unknown';

    this.emitTrace({
      type: 'tool:started',
      module: moduleName,
      tool: call.name,
      callId: call.id,
    });

    const startTime = Date.now();

    // Execute tool asynchronously
    this.moduleRegistry
      .handleToolCall(call)
      .then((result) => {
        const durationMs = Date.now() - startTime;
        this.emitTrace({
          type: 'tool:completed',
          module: moduleName,
          tool: call.name,
          callId: call.id,
          durationMs,
        });

        // Push result to queue
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName,
          result,
        });
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emitTrace({
          type: 'tool:failed',
          module: moduleName,
          tool: call.name,
          callId: call.id,
          error: err.message,
          stack: err.stack,
        });

        // Push error result to queue
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName,
          result: {
            success: false,
            error: err.message,
            isError: true,
          },
        });
      });
  }

  private addMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata
  ): MessageId {
    // Add to first agent's context manager (they all share the same message store)
    const agent = this.agents.values().next().value;
    if (!agent) {
      throw new Error('No agents configured');
    }
    return agent.getContextManager().addMessage(participant, content, metadata);
  }

  private editMessage(id: MessageId, content: ContentBlock[]): void {
    const agent = this.agents.values().next().value;
    if (!agent) {
      throw new Error('No agents configured');
    }
    agent.getContextManager().editMessage(id, content);
  }

  private removeMessage(id: MessageId): void {
    const agent = this.agents.values().next().value;
    if (!agent) {
      throw new Error('No agents configured');
    }
    agent.getContextManager().removeMessage(id);
  }

  private getMessage(id: MessageId): StoredMessage | null {
    const agent = this.agents.values().next().value;
    if (!agent) {
      return null;
    }
    return agent.getContextManager().getMessage(id);
  }

  private queryMessages(filter: MessageQuery): MessageQueryResult {
    const agent = this.agents.values().next().value;
    if (!agent) {
      return { messages: [], totalCount: 0 };
    }
    return agent.getContextManager().queryMessages(filter);
  }

  private createFrameworkState(): FrameworkState {
    return {
      getAgentStatus: (name: string): AgentState | null => {
        const agent = this.agents.get(name);
        return agent?.state ?? null;
      },
      getModule: (name: string): Module | null => {
        return this.moduleRegistry.getModule(name);
      },
      getPendingRequests: (): InferenceRequest[] => {
        return [...this.pendingRequests];
      },
      queueDepth: this.queue.depth,
    };
  }

  private emitTrace(event: { type: TraceEvent['type']; [key: string]: unknown }): void {
    const traceEvent = {
      ...event,
      timestamp: Date.now(),
    } as TraceEvent;

    for (const listener of this.traceListeners) {
      try {
        listener(traceEvent);
      } catch (error) {
        console.error('Trace listener error:', error);
      }
    }
  }
}
