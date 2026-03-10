import type { JsStore } from 'chronicle';
import type { ContentBlock } from 'membrane';
import type {
  MessageId,
  MessageMetadata,
  MessageQuery,
  MessageQueryResult,
  StoredMessage,
  ContextInjection,
} from '@connectome/context-manager';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessQueue,
  ToolDefinition,
  ToolCall,
  ToolResult,
  AgentInfo,
  ExternalIdRef,
  SpeechContext,
  SpeechHandlerOptions,
  ProcessEvent,
} from './types/index.js';
import type { Agent } from './agent.js';

const MODULE_STATE_PREFIX = 'modules/';

/**
 * Registered speech handler.
 */
interface SpeechHandler {
  moduleName: string;
  agents: '*' | string[];
  priority: number;
}


/**
 * Registry for managing modules.
 */
export class ModuleRegistry {
  private modules: Map<string, Module> = new Map();
  private moduleContexts: Map<string, ModuleContextImpl> = new Map();
  private speechHandlers: SpeechHandler[] = [];
  private store: JsStore;
  private queue: ProcessQueue;
  private getAgents: () => Agent[];
  private addMessageFn: (participant: string, content: ContentBlock[], metadata?: MessageMetadata) => MessageId;
  private editMessageFn: (id: MessageId, content: ContentBlock[]) => void;
  private removeMessageFn: (id: MessageId) => void;
  private getMessageFn: (id: MessageId) => StoredMessage | null;
  private queryMessagesFn: (filter: MessageQuery) => MessageQueryResult;

  private pushEventFn: (event: ProcessEvent) => void;

  constructor(
    store: JsStore,
    queue: ProcessQueue,
    options: {
      getAgents: () => Agent[];
      addMessage: (participant: string, content: ContentBlock[], metadata?: MessageMetadata) => MessageId;
      editMessage: (id: MessageId, content: ContentBlock[]) => void;
      removeMessage: (id: MessageId) => void;
      getMessage: (id: MessageId) => StoredMessage | null;
      queryMessages: (filter: MessageQuery) => MessageQueryResult;
      pushEvent: (event: ProcessEvent) => void;
    }
  ) {
    this.store = store;
    this.queue = queue;
    this.getAgents = options.getAgents;
    this.addMessageFn = options.addMessage;
    this.editMessageFn = options.editMessage;
    this.removeMessageFn = options.removeMessage;
    this.getMessageFn = options.getMessage;
    this.queryMessagesFn = options.queryMessages;
    this.pushEventFn = options.pushEvent;
  }

  /**
   * Register and start a module.
   */
  async addModule(module: Module): Promise<void> {
    if (this.modules.has(module.name)) {
      throw new Error(`Module already registered: ${module.name}`);
    }

    // Register module state in store
    const stateId = this.getStateId(module.name);
    try {
      this.store.registerState({
        id: stateId,
        strategy: 'snapshot',
      });
    } catch {
      // State already registered (from previous run)
    }

    // Check if this is a restart (state exists)
    const existingState = this.store.getStateJson(stateId);
    const isRestart = existingState !== null;

    // Create context
    const context = new ModuleContextImpl(
      module.name,
      this.store,
      stateId,
      this.queue,
      this,
      isRestart,
      this.getAgents,
      this.addMessageFn,
      this.editMessageFn,
      this.removeMessageFn,
      this.getMessageFn,
      this.queryMessagesFn,
      this.pushEventFn
    );

    this.modules.set(module.name, module);
    this.moduleContexts.set(module.name, context);

    // Start the module
    await module.start(context);
  }

  /**
   * Stop and unregister a module.
   */
  async removeModule(name: string): Promise<void> {
    const module = this.modules.get(name);
    if (!module) {
      throw new Error(`Module not found: ${name}`);
    }

    await module.stop();
    this.modules.delete(name);
    this.moduleContexts.delete(name);
  }

  /**
   * Get a module by name.
   */
  getModule<T extends Module>(name: string): T | null {
    return (this.modules.get(name) as T) ?? null;
  }

  /**
   * Get all registered modules.
   */
  getAllModules(): Module[] {
    return Array.from(this.modules.values());
  }

  /**
   * Set state for a module by name.
   * Used by the framework to apply stateUpdate from EventResponse atomically.
   */
  setModuleState(moduleName: string, state: unknown): void {
    const ctx = this.moduleContexts.get(moduleName);
    if (ctx) {
      ctx.setState(state);
    }
  }

  /**
   * Get state for a module by name.
   */
  getModuleState<T>(moduleName: string): T | null {
    const ctx = this.moduleContexts.get(moduleName);
    if (ctx) {
      return ctx.getState<T>();
    }
    return null;
  }

  /**
   * Create a ProcessState for a module to use during event processing.
   */
  createProcessState(moduleName: string): ProcessState {
    const ctx = this.moduleContexts.get(moduleName);
    if (!ctx) {
      throw new Error(`Module ${moduleName} not found`);
    }
    return new ProcessStateImpl(moduleName, ctx, this);
  }

  /**
   * Get all available tools from all modules.
   */
  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const module of this.modules.values()) {
      for (const tool of module.getTools()) {
        tools.push({
          ...tool,
          name: `${module.name}--${tool.name}`,
        });
      }
    }
    return tools;
  }

  /**
   * Handle a tool call by routing to the appropriate module.
   */
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    // Parse module--tool name
    const sepIndex = call.name.indexOf('--');
    if (sepIndex === -1) {
      return {
        success: false,
        error: `Invalid tool name format: ${call.name}`,
        isError: true,
      };
    }

    const moduleName = call.name.substring(0, sepIndex);
    const toolName = call.name.substring(sepIndex + 2);

    const module = this.modules.get(moduleName);
    if (!module) {
      return {
        success: false,
        error: `Module not found: ${moduleName}`,
        isError: true,
      };
    }

    // Create a call with the un-prefixed name (preserving caller identity)
    const moduleCall: ToolCall = {
      id: call.id,
      name: toolName,
      input: call.input,
      callerAgentName: call.callerAgentName,
    };

    try {
      return await module.handleToolCall(moduleCall);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  /**
   * Stop all modules.
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.modules.values()).map((m) => m.stop());
    await Promise.all(stopPromises);
    this.modules.clear();
    this.moduleContexts.clear();
    this.speechHandlers = [];
  }

  /**
   * Register a module as a speech handler.
   */
  registerSpeechHandler(
    moduleName: string,
    agents: '*' | string[],
    options: SpeechHandlerOptions = {}
  ): void {
    const priority = options.priority ?? 0;

    if (!options.additive) {
      // Remove existing handlers for this module
      this.speechHandlers = this.speechHandlers.filter(
        (h) => h.moduleName !== moduleName
      );
    }

    this.speechHandlers.push({ moduleName, agents, priority });

    // Sort by priority (higher first)
    this.speechHandlers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Unregister a module as a speech handler.
   */
  unregisterSpeechHandler(moduleName: string): void {
    this.speechHandlers = this.speechHandlers.filter(
      (h) => h.moduleName !== moduleName
    );
  }

  /**
   * Gather context injections from all modules before inference.
   * Calls each module's gatherContext() in parallel with a per-module timeout.
   * Fail-open: timed-out or erroring modules are skipped silently.
   * Adapted from Anarchid/agent-framework@mcpl-module-proto.
   */
  async gatherContext(agentName: string, timeoutMs = 5000): Promise<ContextInjection[]> {
    const injections: ContextInjection[] = [];
    const promises: Promise<void>[] = [];

    for (const module of this.modules.values()) {
      if (!module.gatherContext) continue;

      const promise = Promise.race([
        module.gatherContext(agentName).then(r => injections.push(...r)),
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]).catch(err => console.error(`[${module.name}] gatherContext:`, err));

      promises.push(promise as Promise<void>);
    }

    await Promise.all(promises);
    return injections;
  }

  /**
   * Dispatch speech to registered handlers.
   */
  async dispatchSpeech(
    agentName: string,
    content: ContentBlock[],
    context: SpeechContext
  ): Promise<void> {
    // Find handlers that match this agent
    const handlers = this.speechHandlers.filter(
      (h) => h.agents === '*' || h.agents.includes(agentName)
    );

    // Call each handler
    for (const handler of handlers) {
      const module = this.modules.get(handler.moduleName);
      if (module?.onAgentSpeech) {
        try {
          await module.onAgentSpeech(agentName, content, context);
        } catch (error) {
          console.error(
            `Speech handler ${handler.moduleName} error:`,
            error
          );
        }
      }
    }
  }

  private getStateId(moduleName: string): string {
    return `${MODULE_STATE_PREFIX}${moduleName}/state`;
  }
}

/**
 * Implementation of ModuleContext.
 */
class ModuleContextImpl implements ModuleContext {
  private moduleName: string;
  private store: JsStore;
  private stateId: string;
  readonly queue: ProcessQueue;
  private registry: ModuleRegistry;
  readonly isRestart: boolean;
  private getAgentsFn: () => Agent[];
  private addMessageFn: (participant: string, content: ContentBlock[], metadata?: MessageMetadata) => MessageId;
  private editMessageFn: (id: MessageId, content: ContentBlock[]) => void;
  private removeMessageFn: (id: MessageId) => void;
  private getMessageFn: (id: MessageId) => StoredMessage | null;
  private queryMessagesFn: (filter: MessageQuery) => MessageQueryResult;
  private pushEventFn: (event: ProcessEvent) => void;

  // External ID mapping stored in module state
  private externalIdMap: Map<string, MessageId> = new Map();

  constructor(
    moduleName: string,
    store: JsStore,
    stateId: string,
    queue: ProcessQueue,
    registry: ModuleRegistry,
    isRestart: boolean,
    getAgents: () => Agent[],
    addMessage: (participant: string, content: ContentBlock[], metadata?: MessageMetadata) => MessageId,
    editMessage: (id: MessageId, content: ContentBlock[]) => void,
    removeMessage: (id: MessageId) => void,
    getMessage: (id: MessageId) => StoredMessage | null,
    queryMessages: (filter: MessageQuery) => MessageQueryResult,
    pushEvent: (event: ProcessEvent) => void
  ) {
    this.moduleName = moduleName;
    this.store = store;
    this.stateId = stateId;
    this.queue = queue;
    this.registry = registry;
    this.isRestart = isRestart;
    this.getAgentsFn = getAgents;
    this.addMessageFn = addMessage;
    this.editMessageFn = editMessage;
    this.removeMessageFn = removeMessage;
    this.getMessageFn = getMessage;
    this.queryMessagesFn = queryMessages;
    this.pushEventFn = pushEvent;

    // Load external ID map from state if exists
    const state = this.getState<{ externalIdMap?: Record<string, string> }>();
    if (state?.externalIdMap) {
      this.externalIdMap = new Map(Object.entries(state.externalIdMap));
    }
  }

  getState<T>(): T | null {
    const state = this.store.getStateJson(this.stateId);
    return state as T | null;
  }

  setState<T>(state: T): void {
    // Merge external ID map into state
    const fullState = {
      ...(state as object),
      externalIdMap: Object.fromEntries(this.externalIdMap),
    };
    this.store.setStateJson(this.stateId, fullState);
  }

  getModule<T extends Module>(name: string): T | null {
    return this.registry.getModule<T>(name);
  }

  addMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata & { external?: ExternalIdRef }
  ): MessageId {
    const id = this.addMessageFn(participant, content, metadata);

    // Track external ID if provided
    if (metadata?.external) {
      const key = `${metadata.external.source}:${metadata.external.id}`;
      this.externalIdMap.set(key, id);
      // Persist the mapping
      this.persistExternalIdMap();
    }

    return id;
  }

  editMessage(id: MessageId, content: ContentBlock[]): void {
    this.editMessageFn(id, content);
  }

  removeMessage(id: MessageId): void {
    this.removeMessageFn(id);
    // Clean up external ID mapping
    for (const [key, msgId] of this.externalIdMap) {
      if (msgId === id) {
        this.externalIdMap.delete(key);
        this.persistExternalIdMap();
        break;
      }
    }
  }

  findMessageByExternalId(source: string, externalId: string): MessageId | null {
    const key = `${source}:${externalId}`;
    return this.externalIdMap.get(key) ?? null;
  }

  getMessage(id: MessageId): StoredMessage | null {
    return this.getMessageFn(id);
  }

  queryMessages(filter: MessageQuery): MessageQueryResult {
    return this.queryMessagesFn(filter);
  }

  getAgents(): AgentInfo[] {
    return this.getAgentsFn().map((a) => a.info);
  }

  getActiveTools(): ToolDefinition[] {
    return this.registry.getAllTools();
  }

  registerSpeechHandler(
    agents: '*' | string[],
    options?: SpeechHandlerOptions
  ): void {
    this.registry.registerSpeechHandler(this.moduleName, agents, options);
  }

  unregisterSpeechHandler(): void {
    this.registry.unregisterSpeechHandler(this.moduleName);
  }

  pushEvent(event: ProcessEvent): void {
    this.pushEventFn(event);
  }

  private persistExternalIdMap(): void {
    const currentState = this.getState<object>() ?? {};
    this.setState({
      ...currentState,
      externalIdMap: Object.fromEntries(this.externalIdMap),
    });
  }
}

/**
 * Implementation of ProcessState - read-only state access during event processing.
 */
class ProcessStateImpl implements ProcessState {
  private moduleName: string;
  private ctx: ModuleContextImpl;
  private registry: ModuleRegistry;

  constructor(moduleName: string, ctx: ModuleContextImpl, registry: ModuleRegistry) {
    this.moduleName = moduleName;
    this.ctx = ctx;
    this.registry = registry;
  }

  getState<T>(): T | null {
    return this.ctx.getState<T>();
  }

  getModuleState<T>(name: string): T | null {
    return this.registry.getModuleState<T>(name);
  }

  findMessageByExternalId(source: string, externalId: string): MessageId | null {
    return this.ctx.findMessageByExternalId(source, externalId);
  }

  getAgents(): AgentInfo[] {
    return this.ctx.getAgents();
  }

  getActiveTools(): ToolDefinition[] {
    return this.ctx.getActiveTools();
  }

  get queue(): ProcessQueue {
    return this.ctx.queue;
  }

  pushEvent(event: ProcessEvent): void {
    this.ctx.pushEvent(event);
  }
}
