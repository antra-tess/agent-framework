import { JsStore } from 'chronicle';
import type { Membrane, ContentBlock, NormalizedRequest, YieldingStream, ToolResult as MembraneToolResult } from 'membrane';
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
import { McplServerRegistry } from './mcpl/server-registry.js';
import { FeatureSetManager } from './mcpl/feature-set-manager.js';
import { ScopeManager } from './mcpl/scope-manager.js';
import { HookOrchestrator } from './mcpl/hook-orchestrator.js';
import { PushHandler, type McplPushEvent } from './mcpl/push-handler.js';
import { InferenceRouter } from './mcpl/inference-router.js';
import { ChannelRegistry } from './mcpl/channel-registry.js';
import { CheckpointManager } from './mcpl/checkpoint-manager.js';
import type { McplServerConnection } from './mcpl/server-connection.js';
import type {
  McplServerConfig,
  McplHostCapabilities,
  FeatureSetsChangedParams,
  ScopeElevateParams,
  ScopeElevateResult,
  BeforeInferenceParams,
  AfterInferenceParams,
  PushEventParams,
  McplInferenceRequestParams,
  ChannelsRegisterParams,
  ChannelsChangedParams,
  ChannelsIncomingParams,
} from './mcpl/types.js';
import type { ContextInjection } from '@connectome/context-manager';

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
  private pendingAssistantBlocks: Map<string, ContentBlock[]> = new Map();

  // MCPL subsystems (null when no mcplServers configured)
  private mcplServerRegistry: McplServerRegistry | null = null;
  private featureSetManager: FeatureSetManager | null = null;
  private scopeManager: ScopeManager | null = null;
  private hookOrchestrator: HookOrchestrator | null = null;
  private pushHandler: PushHandler | null = null;
  private inferenceRouter: InferenceRouter | null = null;
  private channelRegistry: ChannelRegistry | null = null;
  private checkpointManager: CheckpointManager | null = null;
  private mcplTools: import('./types/index.js').ToolDefinition[] = [];
  private mcplToolRefreshInFlight = false;
  private mcplToolRefreshPending = false;
  /** Maps tool prefix → serverId for dispatch routing. */
  private mcplPrefixMap: Map<string, string> = new Map();
  /** Maps serverId → McplServerConfig for prefix lookup. */
  private mcplServerConfigs: Map<string, import('./mcpl/types.js').McplServerConfig> = new Map();

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

    // Initialize MCPL subsystems if configured
    if (config.mcplServers && config.mcplServers.length > 0) {
      // Validate tool prefixes: no collisions with module names or between servers
      const moduleNames = new Set(config.modules.map(m => m.name));
      const prefixesSeen = new Map<string, string>(); // prefix → serverId
      for (const serverConfig of config.mcplServers) {
        const prefix = serverConfig.toolPrefix ?? `mcpl:${serverConfig.id}`;
        if (moduleNames.has(prefix)) {
          throw new Error(
            `MCPL server "${serverConfig.id}" toolPrefix "${prefix}" collides with module "${prefix}"`
          );
        }
        const existing = prefixesSeen.get(prefix);
        if (existing) {
          throw new Error(
            `MCPL server "${serverConfig.id}" toolPrefix "${prefix}" collides with server "${existing}"`
          );
        }
        prefixesSeen.set(prefix, serverConfig.id);
      }

      await framework.initializeMcpl(config.mcplServers, config.inferenceRouting);
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

    // Stop typing indicators
    this.channelRegistry?.stopAll();

    // Stop modules and MCPL servers in parallel
    const shutdownPromises: Promise<void>[] = [this.moduleRegistry.stopAll()];
    if (this.mcplServerRegistry) {
      shutdownPromises.push(this.mcplServerRegistry.closeAll());
    }
    await Promise.all(shutdownPromises);

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
   * Get all available tools from all modules and MCPL servers.
   */
  getAllTools(): import('./types/index.js').ToolDefinition[] {
    const moduleTools = this.moduleRegistry.getAllTools();
    const channelTools = this.channelRegistry?.getChannelTools() ?? [];
    if (this.mcplTools.length === 0 && channelTools.length === 0) {
      return moduleTools;
    }
    return [...moduleTools, ...this.mcplTools, ...channelTools];
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
   * Get the Membrane instance.
   */
  getMembrane(): Membrane {
    return this.membrane;
  }

  /**
   * Create an ephemeral agent that is NOT registered in the main event loop.
   *
   * Used by SubagentModule (and similar) to create short-lived agents
   * that are driven externally (not by the framework's event loop).
   * The returned agent has its own ContextManager on a namespaced state
   * within the framework's shared Chronicle store — messages go to
   * `{namespace}/messages`, context log to `{namespace}/context`.
   *
   * Data persists after cleanup for investigation and cross-revert.
   * Call cleanup() when done to release the ContextManager.
   */
  async createEphemeralAgent(config: AgentConfig): Promise<{
    agent: Agent;
    contextManager: ContextManager;
    cleanup: () => void;
  }> {
    const namespace = `subagent/${config.name}`;

    const contextManager = await ContextManager.open({
      store: this.store,
      namespace,
      isolate: true,
      strategy: config.strategy ?? new PassthroughStrategy(),
      membrane: this.membrane,
      debugLogContext: !!process.env.DEBUG_CONTEXT,
    });

    const agent = new Agent(config, contextManager, this.membrane);

    const cleanup = () => {
      // Don't close the store — it's shared. Just release the CM.
      // Data persists in the store under the namespace for investigation.
    };

    return { agent, contextManager, cleanup };
  }

  /**
   * Run an ephemeral agent to completion through the framework's event loop.
   *
   * The agent is temporarily registered, inference is triggered, and the
   * framework drives the stream (emitting traces, logging, dispatching tools).
   * Returns the agent's speech output when it finishes (no more tool calls).
   *
   * The caller provides a pre-created agent + contextManager (from createEphemeralAgent).
   * The task message should already be in the context manager.
   */
  async runEphemeralToCompletion(
    agent: Agent,
    contextManager: ContextManager,
  ): Promise<{ speech: string; toolCallsCount: number }> {
    // Register temporarily so the event loop can drive it
    this.agents.set(agent.name, agent);

    return new Promise<{ speech: string; toolCallsCount: number }>((resolve, reject) => {
      let speech = '';
      let toolCallsCount = 0;
      let settled = false;
      let inferenceStarted = false;

      const STARTUP_TIMEOUT_MS = 30_000;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startupWatchdog);
        this.offTrace(traceListener);
        this.agents.delete(agent.name);
      };

      // Watchdog: if inference never starts within 30s, the agent is a zombie.
      // This catches cases where the event loop stalled, the agent was
      // deregistered, or processInferenceRequests() skipped the request.
      const startupWatchdog = setTimeout(() => {
        if (!inferenceStarted && !settled) {
          cleanup();
          reject(new Error(
            `Ephemeral agent "${agent.name}" failed to start inference within ` +
            `${STARTUP_TIMEOUT_MS}ms — zombie detected. The event loop may have ` +
            `stalled or the inference request was dropped.`
          ));
        }
      }, STARTUP_TIMEOUT_MS);

      const traceListener = (event: TraceEvent) => {
        if (settled) return;
        // Only track events for our ephemeral agent
        const agentName = 'agentName' in event ? (event as { agentName: string }).agentName : null;
        if (agentName !== agent.name) return;

        switch (event.type) {
          case 'inference:started':
            inferenceStarted = true;
            break;
          case 'inference:tokens': {
            inferenceStarted = true;
            const content = (event as { content?: string }).content;
            if (content) speech += content;
            break;
          }
          case 'inference:tool_calls_yielded': {
            const calls = (event as { calls?: Array<unknown> }).calls;
            if (calls) toolCallsCount += calls.length;
            // Reset speech buffer — tool calls break the text
            speech = '';
            break;
          }
          case 'inference:stream_resumed':
            speech = '';
            break;
          case 'inference:completed': {
            // Check if agent is idle (no pending tool calls = truly done)
            // If tools were called, the agent will cycle through waiting_for_tools → ready → streaming
            // and eventually complete again. We only resolve when there are no more tool calls.
            if (agent.state.status === 'idle') {
              cleanup();
              resolve({ speech, toolCallsCount });
            }
            break;
          }
          case 'inference:turn_ended': {
            // endTurn from a tool result — agent is done
            cleanup();
            resolve({ speech, toolCallsCount });
            break;
          }
          case 'inference:exhausted': {
            // Retries exhausted — reject only after the error policy gives up.
            // Earlier inference:failed events are left alone so the framework
            // retry path in driveStream/startAgentStream can restart the stream
            // while this listener stays alive.
            const error = (event as { error?: string }).error ?? 'Unknown error';
            cleanup();
            reject(new Error(error));
            break;
          }
        }
      };

      this.onTrace(traceListener);

      // Trigger inference
      this.pendingRequests.push({
        agentName: agent.name,
        reason: 'ephemeral',
        source: 'subagent',
        timestamp: Date.now(),
      });
    });
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
      debugLogContext: !!process.env.DEBUG_CONTEXT,
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

    // Built-in: convert MCPL events to context messages.
    // These events are protocol-level (spec Sections 9 & 14) and always
    // represent content intended for the model's context window.
    if (event.type === 'mcpl:channel-incoming') {
      this.handleMcplChannelIncoming(event as unknown as {
        type: 'mcpl:channel-incoming';
        serverId: string;
        channelId: string;
        messageId: string;
        threadId?: string;
        author: { id: string; name: string };
        content: ContentBlock[];
        timestamp: string;
        metadata?: Record<string, unknown>;
        triggerInference?: boolean;
      });
    } else if (event.type === 'mcpl:push-event') {
      this.handleMcplPushEvent(event as unknown as McplPushEvent);
    }

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
          // Flush pending assistant blocks (tool_use + preamble text) to context
          const pendingBlocks = this.pendingAssistantBlocks.get(agent.name);
          if (pendingBlocks) {
            agent.addAssistantResponse(pendingBlocks);
            this.pendingAssistantBlocks.delete(agent.name);
          }

          // Compute truncation limit from agent's strategy (maxMessageTokens * 4 chars)
          const maxChars = this.getMaxToolResultChars(agent);

          // Store tool results as a user message (tool_result blocks)
          const toolResultContent: ContentBlock[] = currentState.toolResults.map(tc => {
            let content: string;
            if (tc.result.isError) {
              content = tc.result.error ?? 'Unknown error';
            } else {
              content = JSON.stringify(tc.result.data);
              if (maxChars && content.length > maxChars) {
                content = content.slice(0, maxChars)
                  + '\n\n[truncated — original was ' + content.length + ' chars]';
              }
            }
            return {
              type: 'tool_result' as const,
              toolUseId: tc.id,
              content,
              isError: tc.result.isError,
            };
          });
          agent.getContextManager().addMessage('user', toolResultContent);

          // Check if any tool result requested endTurn
          const shouldEndTurn = currentState.toolResults.some(tc => tc.result.endTurn);

          // Check if accumulated input tokens exceed the agent's budget
          const overBudget = currentState.stream
            && agent.lastStreamInputTokens > 0
            && agent.lastStreamInputTokens > agent.maxStreamTokens;

          if (shouldEndTurn) {
            // endTurn: messages already stored above, cancel stream, reset to idle.
            if (currentState.stream) {
              agent.cancelStream();
            }
            agent.reset();
            this.emitTrace({ type: 'inference:turn_ended', agentName: agent.name });
          } else if (overBudget) {
            // Context budget exceeded: break the stream, let compile() compress
            agent.cancelStream();
            this.emitTrace({
              type: 'inference:stream_restarted',
              agentName: agent.name,
              reason: 'context_budget',
              inputTokens: agent.lastStreamInputTokens,
              budget: agent.maxStreamTokens,
            });
            this.pendingRequests.push({
              agentName: agent.name,
              reason: 'context_budget_restart',
              source: 'framework',
              timestamp: Date.now(),
            });
          } else if (currentState.stream) {
            // Streaming path: convert results and resume the stream
            const membraneResults = currentState.toolResults.map(tc =>
              this.toMembraneToolResult(tc.id, tc.result, maxChars)
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

  // ==========================================================================
  // Built-in MCPL event → context message conversion
  // ==========================================================================

  /**
   * Convert an incoming MCPL channel message to a context message.
   * This replaces the old MCPLModule.onProcess() message conversion.
   */
  private handleMcplChannelIncoming(event: {
    type: 'mcpl:channel-incoming';
    serverId: string;
    channelId: string;
    messageId: string;
    threadId?: string;
    author: { id: string; name: string };
    content: ContentBlock[];
    timestamp: string;
    metadata?: Record<string, unknown>;
    triggerInference?: boolean;
  }): void {
    const metadata: Record<string, unknown> = {
      ...event.metadata,
      channelId: event.channelId,
      messageId: event.messageId,
      author: event.author,
      triggered: event.triggerInference ?? false,
      serverId: event.serverId,
    };
    if (event.threadId) metadata.threadId = event.threadId;

    const id = this.addMessage('user', event.content, metadata);
    this.emitTrace({ type: 'message:added', messageId: id, source: 'mcpl:channel-incoming' });

    if (event.triggerInference) {
      for (const agentName of this.agents.keys()) {
        this.pendingRequests.push({
          agentName,
          reason: 'mcpl:channel-incoming',
          source: event.serverId,
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Convert an MCPL push event to a context message.
   */
  private handleMcplPushEvent(event: McplPushEvent): void {
    const metadata: Record<string, unknown> = {
      ...event.origin,
      serverId: event.serverId,
      featureSet: event.featureSet,
      eventId: event.eventId,
      triggered: event.triggerInference ?? false,
    };

    const id = this.addMessage('user', event.content, metadata);
    this.emitTrace({ type: 'message:added', messageId: id, source: 'mcpl:push-event' });

    if (event.triggerInference) {
      const targetAgents = event.targetAgents ?? [...this.agents.keys()];
      for (const agentName of targetAgents) {
        this.pendingRequests.push({
          agentName,
          reason: 'mcpl:push-event',
          source: event.serverId,
          timestamp: Date.now(),
        });
      }
    }
  }

  private async processInferenceRequests(): Promise<void> {
    if (this.pendingRequests.length === 0) {
      return;
    }

    const STALE_REQUEST_MS = 30_000;
    const now = Date.now();
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
      if (!agent) {
        // Agent not found — request is orphaned. Emit warning and drop.
        const oldest = Math.min(...requests.map(r => r.timestamp));
        this.emitTrace({
          type: 'inference:request_dropped',
          agentName,
          reason: 'agent_not_found',
          requestCount: requests.length,
          oldestRequestAge: now - oldest,
        });
        continue;
      }

      // Skip if agent is busy (inferring, streaming, or waiting for tools)
      if (agent.state.status === 'inferring' || agent.state.status === 'streaming' || agent.state.status === 'waiting_for_tools') {
        // Re-queue requests, but warn if they've been pending too long
        const oldest = Math.min(...requests.map(r => r.timestamp));
        if (now - oldest > STALE_REQUEST_MS) {
          this.emitTrace({
            type: 'inference:request_stale',
            agentName,
            agentStatus: agent.state.status,
            requestCount: requests.length,
            oldestRequestAge: now - oldest,
          });
        }
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
      const tools = this.getAllTools().filter((t) => agent.canUseTool(t.name));

      // Gather context from modules (pull-based) and MCPL hooks (push-based)
      // Both produce ContextInjection[] that get merged before inference.
      let injections: ContextInjection[] | undefined;

      // Module gatherContext (fail-open, 5s timeout per module)
      try {
        const moduleInjections = await this.moduleRegistry.gatherContext(agent.name);
        if (moduleInjections.length > 0) {
          injections = moduleInjections;
        }
      } catch (error) {
        console.error('Module gatherContext error:', error);
      }

      // MCPL beforeInference hooks (fail-open)
      if (this.hookOrchestrator) {
        try {
          const hookParams = this.buildBeforeInferenceParams(agent, trigger);
          const hookInjections = await this.hookOrchestrator.beforeInference(hookParams);
          if (hookInjections.length > 0) {
            injections = injections ? [...injections, ...hookInjections] : hookInjections;
          }
        } catch (error) {
          console.error('beforeInference hook error:', error);
        }
      }

      const { stream, request: compiledRequest } = await agent.startStreamWithInjections(tools, injections);

      const handle = this.driveStream(agent, stream, trigger, attempt, compiledRequest);
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
      } else {
        this.emitTrace({
          type: 'inference:exhausted',
          agentName: agent.name,
          error: err.message,
        });
        if (action.emit) {
          this.pushEvent(action.emit);
        }
      }
    }
  }

  private async driveStream(
    agent: Agent,
    stream: YieldingStream,
    trigger?: InferenceRequest,
    attempt = 0,
    compiledRequest?: NormalizedRequest
  ): Promise<void> {
    const startTime = Date.now();
    const requestId = `${agent.name}-${startTime}-${Math.random().toString(36).slice(2, 8)}`;
    const myStreamId = agent.streamId;
    let hadToolCalls = false;

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

          case 'tool-calls': {
            hadToolCalls = true;
            this.emitTrace({
              type: 'inference:tool_calls_yielded',
              agentName: agent.name,
              calls: event.calls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
            });

            // Build assistant content blocks from preamble text + tool_use blocks
            const assistantBlocks: ContentBlock[] = [];
            if (event.context.preamble) {
              assistantBlocks.push({ type: 'text', text: event.context.preamble });
            }
            for (const c of event.calls) {
              assistantBlocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input as Record<string, unknown> });
            }
            this.pendingAssistantBlocks.set(agent.name, assistantBlocks);

            agent.enterWaitingForTools(event.calls, stream);
            // Dispatch each tool call (async, results come back via ToolResultEvent)
            for (const call of event.calls) {
              this.dispatchToolCall(agent.name, call);
            }
            // Stream's async iterator blocks on next() until provideToolResults() is called
            break;
          }

          case 'complete': {
            const durationMs = Date.now() - startTime;
            const response = event.response;

            // Add assistant response to context.
            // If we had tool calls, the tool_use blocks were already stored as
            // pendingAssistantBlocks and flushed when tool results arrived.
            // Only store trailing content (text after the last tool round) to
            // avoid double-storing tool_use blocks.
            if (hadToolCalls) {
              // Filter to only trailing text/thinking blocks (no tool_use — those are already stored)
              const trailingContent = response.content.filter(
                (block: ContentBlock) => block.type !== 'tool_use' && block.type !== 'tool_result'
              );
              if (trailingContent.length > 0) {
                agent.addAssistantResponse(trailingContent);
              }
            } else {
              agent.addAssistantResponse(response.content);
            }

            // Run afterInference hooks (no-op if no MCPL servers)
            if (this.hookOrchestrator) {
              try {
                const speechText = response.content
                  .filter((block: ContentBlock): block is ContentBlock & { type: 'text' } => block.type === 'text')
                  .map((b) => b.text)
                  .join('\n');

                const afterParams: AfterInferenceParams = {
                  inferenceId: requestId,
                  conversationId: agent.name,
                  turnIndex: 0,
                  userMessage: null,
                  assistantMessage: speechText,
                  model: {
                    id: agent.model,
                    vendor: 'unknown',
                    contextWindow: 200000,
                    capabilities: ['tools'],
                  },
                  usage: {
                    inputTokens: response.usage?.inputTokens ?? 0,
                    outputTokens: response.usage?.outputTokens ?? 0,
                    cacheCreationTokens: response.details?.usage?.cacheCreationTokens,
                    cacheReadTokens: response.details?.usage?.cacheReadTokens,
                  },
                };

                await this.hookOrchestrator.afterInference(afterParams);
              } catch (error) {
                // Fail-open: continue with speech dispatch
                console.error('afterInference hook error:', error);
              }
            }

            // Extract speech content
            const speechContent = response.content.filter(
              (block: ContentBlock): block is ContentBlock & { type: 'text' } =>
                block.type === 'text'
            );

            const tokenUsage = response.usage
              ? {
                  input: response.usage.inputTokens,
                  output: response.usage.outputTokens,
                  cacheCreation: response.details?.usage?.cacheCreationTokens,
                  cacheRead: response.details?.usage?.cacheReadTokens,
                }
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
              request: compiledRequest ?? { note: 'streaming request' },
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
              request: compiledRequest ?? { note: 'streaming request failed' },
              durationMs,
            });

            // Only reset + retry if this is still the active stream
            if (agent.streamId !== myStreamId) break;

            agent.reset();

            const action = this.errorPolicy.onInferenceError(err, agent.name, attempt);
            if (action.retry) {
              await new Promise((resolve) => setTimeout(resolve, action.delayMs));
              await this.startAgentStream(agent, trigger, attempt + 1);
            } else {
              this.emitTrace({
                type: 'inference:exhausted',
                agentName: agent.name,
                error: err.message,
              });
              if (action.emit) {
                this.pushEvent(action.emit);
              }
            }
            break;
          }

          case 'aborted': {
            const reason = event.reason ?? 'unknown';
            // Only reset if this is still the active stream (a budget restart
            // may have already started a new stream, bumping streamId)
            if (agent.streamId === myStreamId) {
              agent.reset();
              this.emitTrace({
                type: 'inference:exhausted',
                agentName: agent.name,
                error: `Stream aborted: ${reason}`,
              });
            }
            break;
          }

          case 'usage':
            agent.lastStreamInputTokens = event.usage.inputTokens;
            this.emitTrace({
              type: 'inference:usage',
              agentName: agent.name,
              tokenUsage: {
                input: event.usage.inputTokens,
                output: event.usage.outputTokens,
              },
            });
            break;
        }
      }
    } catch (error) {
      // Stream itself threw (unexpected) — no retry path here, so also emit
      // inference:exhausted so ephemeral agent promises can settle.
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitTrace({
        type: 'inference:failed',
        agentName: agent.name,
        error: err.message,
        stack: err.stack,
      });
      this.emitTrace({
        type: 'inference:exhausted',
        agentName: agent.name,
        error: err.message,
      });
      agent.reset();
    } finally {
      this.activeStreams.delete(agent.name);
      this.pendingAssistantBlocks.delete(agent.name);
    }
  }

  /**
   * Execute a tool call and return the result.
   * Routes to the appropriate handler (module registry or MCPL).
   * Used by SubagentModule to dispatch tool calls for ephemeral agents.
   */
  async executeToolCall(call: ToolCall): Promise<ToolResult> {
    // MCPL tools are dispatched via the MCPL subsystem
    if (this.mcplServerRegistry) {
      // Check if this is an MCPL-prefixed tool
      const prefix = call.name.split(':').slice(0, -1).join(':');
      const serverConfigs = this.mcplServerConfigs;
      for (const [, config] of serverConfigs) {
        const toolPrefix = config.toolPrefix ?? `mcpl:${config.id}`;
        if (call.name.startsWith(toolPrefix + ':')) {
          return this.executeMcplToolCall(call, config);
        }
      }
    }

    // Module tools
    return this.moduleRegistry.handleToolCall(call);
  }

  private async executeMcplToolCall(call: ToolCall, config: McplServerConfig): Promise<ToolResult> {
    if (!this.mcplServerRegistry) {
      return { success: false, error: 'MCPL not initialized', isError: true };
    }
    const server = this.mcplServerRegistry.getServer(config.id);
    if (!server) {
      return { success: false, error: `MCPL server ${config.id} not found`, isError: true };
    }
    const prefix = config.toolPrefix ?? `mcpl:${config.id}`;
    const toolName = call.name.slice(prefix.length + 1); // Strip prefix + ':'
    try {
      const result = await server.sendToolsCall(toolName, call.input as Record<string, unknown>);
      return {
        success: true,
        data: result.content,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  private toMembraneToolResult(callId: string, afResult: ToolResult, maxChars?: number): MembraneToolResult {
    let content: string;
    if (afResult.isError) {
      content = afResult.error ?? 'Unknown error';
    } else {
      content = JSON.stringify(afResult.data);
      if (maxChars && content.length > maxChars) {
        content = content.slice(0, maxChars)
          + '\n\n[truncated — original was ' + content.length + ' chars]';
      }
    }
    return { toolUseId: callId, content, isError: afResult.isError };
  }

  private getMaxToolResultChars(agent: Agent): number | undefined {
    const strategy = agent.getContextManager().getStrategy();
    const maxTokens = strategy.maxMessageTokens;
    if (maxTokens && maxTokens > 0) return maxTokens * 4;
    return undefined;
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

  /**
   * Find the MCPL server for a tool call by checking against the prefix map.
   * Returns [serverId, prefix] if found, null otherwise.
   */
  private resolveMcplTool(toolName: string): [string, string] | null {
    for (const [prefix, serverId] of this.mcplPrefixMap) {
      if (toolName.startsWith(prefix + ':')) {
        return [serverId, prefix];
      }
    }
    return null;
  }

  private dispatchToolCall(agentName: string, call: ToolCall): void {
    // Enrich call with caller identity so modules can resolve the calling agent
    const enrichedCall: ToolCall = { ...call, callerAgentName: agentName };

    // Route MCPL tool calls to the appropriate server via prefix map
    const mcplMatch = this.resolveMcplTool(enrichedCall.name);
    if (mcplMatch && this.mcplServerRegistry) {
      this.dispatchMcplToolCall(agentName, enrichedCall, mcplMatch[0], mcplMatch[1]);
      return;
    }

    // Route synthesized channel tools
    if (enrichedCall.name.startsWith('channel_') && this.channelRegistry) {
      this.dispatchChannelToolCall(agentName, enrichedCall);
      return;
    }

    const colonIndex = enrichedCall.name.indexOf(':');
    const moduleName = colonIndex >= 0 ? enrichedCall.name.substring(0, colonIndex) : 'unknown';

    this.emitTrace({
      type: 'tool:started',
      module: moduleName,
      tool: enrichedCall.name,
      callId: enrichedCall.id,
      input: enrichedCall.input,
    });

    const startTime = Date.now();

    // Execute tool asynchronously
    this.moduleRegistry
      .handleToolCall(enrichedCall)
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

  // ==========================================================================
  // MCPL subsystem wiring
  // ==========================================================================

  /**
   * Initialize all MCPL subsystems and connect configured servers.
   * Fail-open: individual server connection failures don't prevent framework startup.
   */
  private async initializeMcpl(
    serverConfigs: McplServerConfig[],
    inferenceRouting?: import('./mcpl/types.js').InferenceRoutingPolicy,
  ): Promise<void> {
    this.mcplServerRegistry = new McplServerRegistry();
    this.featureSetManager = new FeatureSetManager();
    this.scopeManager = new ScopeManager();
    this.hookOrchestrator = new HookOrchestrator(this.mcplServerRegistry, this.featureSetManager);

    // Build prefix map and store configs for tool routing
    for (const config of serverConfigs) {
      const prefix = config.toolPrefix ?? `mcpl:${config.id}`;
      this.mcplPrefixMap.set(prefix, config.id);
      this.mcplServerConfigs.set(config.id, config);
    }

    // Find shouldTriggerInference callback from server configs (first one wins)
    const triggerFilter = serverConfigs.find(c => c.shouldTriggerInference)?.shouldTriggerInference;

    // Push events handler (Step 6)
    this.pushHandler = new PushHandler(
      this.featureSetManager,
      (event) => this.pushEvent(event as unknown as ProcessEvent),
      (event) => this.emitTrace(event as { type: TraceEvent['type']; [key: string]: unknown }),
      triggerFilter,
    );

    // Server-initiated inference router (Step 6)
    this.inferenceRouter = new InferenceRouter(
      this.membrane,
      this.hookOrchestrator,
      this.featureSetManager,
      inferenceRouting ?? null,
      (event) => this.emitTrace(event as { type: TraceEvent['type']; [key: string]: unknown }),
      (serverId, params) => {
        const server = this.mcplServerRegistry!.getServer(serverId);
        server?.sendInferenceChunk(params);
      },
    );

    // Checkpoint manager (Step 8)
    this.checkpointManager = new CheckpointManager(
      this.store,
      (event) => this.emitTrace(event as { type: TraceEvent['type']; [key: string]: unknown }),
    );

    // Channel registry (Step 7)
    this.channelRegistry = new ChannelRegistry(
      this.mcplServerRegistry,
      this.featureSetManager,
      (event) => this.pushEvent(event),
      (event) => this.emitTrace(event as { type: TraceEvent['type']; [key: string]: unknown }),
      {
        sendTypingFn: (serverId, channelId) => {
          const server = this.mcplServerRegistry!.getServer(serverId);
          if (server) {
            server.sendChannelsTyping(channelId);
          }
        },
        shouldTriggerInference: triggerFilter,
      },
    );

    // Host capabilities advertised during the MCP handshake
    const hostCapabilities: McplHostCapabilities = {
      version: '0.4',
      pushEvents: true,
      contextHooks: {
        beforeInference: true,
        afterInference: { blocking: true },
      },
      featureSets: true,
    };

    for (const config of serverConfigs) {
      try {
        const connection = await this.mcplServerRegistry.addServer(config, hostCapabilities);

        // Wire event listeners then flush any events that arrived during the
        // handshake window (between setupMessageRouting and now).
        this.wireMcplEvents(connection);
        connection.ready();

        // Initialize feature sets if server advertises MCPL capabilities
        if (connection.capabilities) {
          const updateParams = this.featureSetManager.initializeServer(
            config.id,
            connection.capabilities,
            {
              enabledFeatureSets: config.enabledFeatureSets,
              disabledFeatureSets: config.disabledFeatureSets,
            },
          );

          // Inform server which feature sets are enabled/disabled
          if (updateParams.enabled?.length || updateParams.disabled?.length) {
            connection.sendFeatureSetsUpdate(updateParams);
          }

          // Configure scope whitelist/blacklist patterns
          if (config.scopes) {
            this.scopeManager.configureAll(config.scopes);
          }

          // Register stateful feature sets with checkpoint manager (Step 8)
          if (this.checkpointManager) {
            const declared = this.featureSetManager.getDeclaredFeatureSets(config.id);
            if (declared) {
              for (const [fsName, fsDecl] of Object.entries(declared)) {
                if (fsDecl.rollback || fsDecl.hostState) {
                  this.checkpointManager.registerFeatureSet(config.id, fsName, {
                    hostState: fsDecl.hostState ?? false,
                    rollback: fsDecl.rollback ?? false,
                  });
                }
              }
            }
          }
        }

        this.emitTrace({ type: 'module:added', moduleName: `mcpl:${config.id}` });
      } catch (error) {
        // Fail-open: log and continue with remaining servers
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`Failed to connect MCPL server "${config.id}":`, err.message);
      }
    }

    // Discover tools from all connected servers
    await this.refreshMcplTools();
  }

  /**
   * Wire event listeners on an MCPL server connection.
   * Push events and inference requests are deferred to Steps 6/7.
   */
  private wireMcplEvents(connection: McplServerConnection): void {
    // Handle dynamic feature set changes from server
    connection.on('feature-sets-changed', (params: FeatureSetsChangedParams) => {
      this.featureSetManager?.handleFeatureSetsChanged(connection.id, params);
    });

    // Handle scope elevation requests
    connection.on('scope-elevate', async (
      params: ScopeElevateParams,
      responder?: { respond: (result: unknown) => void; respondError: (code: number, message: string) => void },
    ) => {
      if (this.scopeManager && responder) {
        try {
          const result: ScopeElevateResult = await this.scopeManager.handleElevation(params);
          responder.respond(result);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          responder.respondError(-32603, err.message);
        }
      }
    });

    // Handle push events (Step 6)
    connection.on('push-event', (
      params: PushEventParams,
      responder?: { respond: (result: unknown) => void; respondError: (code: number, message: string) => void },
    ) => {
      this.pushHandler?.handlePushEvent(connection.id, params, responder as never);
    });

    // Handle server-initiated inference requests (Step 6)
    connection.on('inference-request', async (
      params: McplInferenceRequestParams,
      responder?: { id: string | number; respond: (result: unknown) => void; respondError: (code: number, message: string) => void },
    ) => {
      if (this.inferenceRouter && responder) {
        await this.inferenceRouter.handleInferenceRequest(connection.id, params, {
          respond: responder.respond,
          respondError: responder.respondError,
          requestId: responder.id,
        });
      }
    });

    // Handle channel registration (Step 7)
    connection.on('channels-register', async (
      params: ChannelsRegisterParams,
      responder?: { respond: (result: unknown) => void },
    ) => {
      await this.channelRegistry?.handleRegister(connection.id, params, responder as never);
    });

    // Handle channel changes (Step 7)
    connection.on('channels-changed', async (params: ChannelsChangedParams) => {
      await this.channelRegistry?.handleChanged(connection.id, params);
    });

    // Handle incoming channel messages (Step 7)
    connection.on('channels-incoming', (
      params: ChannelsIncomingParams,
      responder?: { respond: (result: unknown) => void },
    ) => {
      this.channelRegistry?.handleIncoming(connection.id, params, responder as never);
    });

    // Handle dynamic tool list changes (notifications/tools/list_changed)
    connection.on('tools-list-changed', () => {
      this.handleToolsListChanged(connection.id);
    });

    // Also refresh tools on reconnect (server may have different tools)
    connection.on('reconnect', () => {
      this.handleToolsListChanged(connection.id);
    });

    // Cleanup on disconnect
    connection.on('close', () => {
      this.featureSetManager?.removeServer(connection.id);
      this.checkpointManager?.removeServer(connection.id);
      this.emitTrace({ type: 'module:removed', moduleName: `mcpl:${connection.id}` });
    });
  }

  /**
   * Discover tools from all connected MCPL servers and cache them.
   * Tools are namespaced as `{toolPrefix}:{toolName}` per server config.
   */
  private async refreshMcplTools(): Promise<void> {
    if (!this.mcplServerRegistry) return;

    const tools: import('./types/index.js').ToolDefinition[] = [];

    for (const server of this.mcplServerRegistry.getAllServers()) {
      const config = this.mcplServerConfigs.get(server.id);
      const prefix = config?.toolPrefix ?? `mcpl:${server.id}`;
      try {
        const result = await server.sendToolsList();
        for (const tool of result.tools) {
          // MCP tool schemas are generic JSON Schema; cast to membrane's ToolDefinition format
          const schema = tool.inputSchema as import('./types/index.js').ToolDefinition['inputSchema'];
          tools.push({
            name: `${prefix}:${tool.name}`,
            description: tool.description ?? '',
            inputSchema: schema,
          });
        }
      } catch {
        // Server may not support tools/list — skip silently
      }
    }

    this.mcplTools = tools;
  }

  /**
   * Handle a tools/list_changed notification with collapse logic.
   * At most 2 refresh cycles can be in-flight: one running and one pending.
   */
  private handleToolsListChanged(serverId: string): void {
    if (this.mcplToolRefreshInFlight) {
      this.mcplToolRefreshPending = true;
      return;
    }

    this.mcplToolRefreshInFlight = true;
    const oldToolNames = new Set(this.mcplTools.map(t => t.name));

    this.refreshMcplTools()
      .then(() => {
        this.emitMcplToolDiff(oldToolNames, serverId);
      })
      .catch((error) => {
        console.error('MCPL tool refresh error:', error);
      })
      .finally(() => {
        this.mcplToolRefreshInFlight = false;
        if (this.mcplToolRefreshPending) {
          this.mcplToolRefreshPending = false;
          this.handleToolsListChanged(serverId);
        }
      });
  }

  /**
   * Emit a trace event and push an external-message listing newly added tools.
   */
  private emitMcplToolDiff(oldToolNames: Set<string>, serverId: string): void {
    const newTools = this.mcplTools.filter(t => !oldToolNames.has(t.name));
    const removedTools = [...oldToolNames].filter(name => !this.mcplTools.some(t => t.name === name));

    if (newTools.length === 0 && removedTools.length === 0) return;

    this.emitTrace({
      type: 'module:added',
      moduleName: `mcpl:${serverId}:tools-refreshed`,
    });

    if (newTools.length > 0) {
      const toolList = newTools.map(t => t.name).join(', ');
      this.pushEvent({
        type: 'external-message',
        source: `mcpl:${serverId}`,
        content: `New tools available: ${toolList}`,
        metadata: { newTools: newTools.map(t => t.name), removedTools },
      });
    }
  }

  /**
   * Dispatch a tool call to an MCPL server.
   * Strips the configured toolPrefix and routes to the server.
   */
  private dispatchMcplToolCall(agentName: string, call: ToolCall, serverId: string, prefix: string): void {
    const toolName = call.name.slice(prefix.length + 1); // strip "{prefix}:"
    const server = this.mcplServerRegistry!.getServer(serverId);

    if (!server) {
      this.pushEvent({
        type: 'tool-result',
        callId: call.id,
        agentName,
        moduleName: `mcpl:${serverId}`,
        result: { success: false, error: `MCPL server not found: ${serverId}`, isError: true },
      });
      return;
    }

    this.emitTrace({ type: 'tool:started', module: `mcpl:${serverId}`, tool: toolName, callId: call.id, input: call.input });
    const startTime = Date.now();
    const args = (call.input && typeof call.input === 'object') ? call.input as Record<string, unknown> : {};

    // Build state params for stateful tools (Step 8)
    let stateParams: { state?: unknown; checkpoint?: string } | undefined;
    if (this.checkpointManager) {
      const fs = this.checkpointManager.getStatefulFeatureSet(serverId);
      if (fs) {
        if (this.checkpointManager.isHostManaged(serverId, fs)) {
          stateParams = { state: this.checkpointManager.getCurrentState(serverId, fs) };
        } else {
          const cp = this.checkpointManager.getCurrentCheckpoint(serverId, fs);
          if (cp) stateParams = { checkpoint: cp };
        }
      }
    }

    server.sendToolsCall(toolName, args, stateParams)
      .then((result) => {
        const durationMs = Date.now() - startTime;
        this.emitTrace({ type: 'tool:completed', module: `mcpl:${serverId}`, tool: toolName, callId: call.id, durationMs });

        // Record checkpoint from stateful tool response (Step 8)
        if (result.state && this.checkpointManager) {
          const fs = this.checkpointManager.getStatefulFeatureSet(serverId);
          if (fs) {
            this.checkpointManager.recordCheckpoint(serverId, fs, result.state);
          }
        }

        // Convert MCP tool result to framework ToolResult
        const textContent = result.content
          ?.filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
          .join('\n');

        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: `mcpl:${serverId}`,
          result: {
            success: !result.isError,
            data: result.isError ? undefined : textContent || undefined,
            error: result.isError ? (textContent || 'Tool call failed') : undefined,
            isError: result.isError ?? false,
          },
        });
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emitTrace({ type: 'tool:failed', module: `mcpl:${serverId}`, tool: toolName, callId: call.id, error: err.message, stack: err.stack });

        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: `mcpl:${serverId}`,
          result: { success: false, error: err.message, isError: true },
        });
      });
  }

  /**
   * Build BeforeInferenceParams from agent state and trigger context.
   */
  /**
   * Dispatch a synthesized channel tool call.
   */
  private dispatchChannelToolCall(agentName: string, call: ToolCall): void {
    this.emitTrace({ type: 'tool:started', module: 'channels', tool: call.name, callId: call.id, input: call.input });
    const startTime = Date.now();

    this.channelRegistry!.handleChannelToolCall(call.name, call.input)
      .then((result) => {
        const durationMs = Date.now() - startTime;
        this.emitTrace({ type: 'tool:completed', module: 'channels', tool: call.name, callId: call.id, durationMs });
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: 'channels',
          result,
        });
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emitTrace({ type: 'tool:failed', module: 'channels', tool: call.name, callId: call.id, error: err.message });
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: 'channels',
          result: { success: false, error: err.message, isError: true },
        });
      });
  }

  private buildBeforeInferenceParams(agent: Agent, trigger?: InferenceRequest): BeforeInferenceParams {
    const inferenceId = `${agent.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      inferenceId,
      conversationId: agent.name, // Simplified; proper conversation tracking TODO
      turnIndex: 0, // Simplified; needs per-conversation counter TODO
      userMessage: null, // Could extract from trigger context
      model: {
        id: agent.model,
        vendor: 'unknown',
        contextWindow: 200000,
        capabilities: ['tools'],
      },
      channels: this.channelRegistry?.buildChannelContext(),
    };
  }
}
