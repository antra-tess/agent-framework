import type { ContentBlock } from 'membrane';
import type { MessageId, MessageMetadata } from '@connectome/context-manager';
import type { ProcessEvent, ToolDefinition, ToolCall, ToolResult } from './events.js';

/**
 * A pluggable module that provides capabilities to the framework.
 */
export interface Module {
  /** Unique name, used for tool namespacing and state storage */
  readonly name: string;

  /**
   * Start the module.
   * Called when the framework starts or when the module is added.
   */
  start(ctx: ModuleContext): Promise<void>;

  /**
   * Stop the module.
   * Called when the framework stops or when the module is removed.
   */
  stop(): Promise<void>;

  /**
   * Get currently available tools.
   * Can change over time (e.g., based on connection state).
   */
  getTools(): ToolDefinition[];

  /**
   * Handle a tool call.
   * Tool name is without module prefix.
   */
  handleToolCall(call: ToolCall): Promise<ToolResult>;

  /**
   * Handle a process event from the queue.
   * Return response indicating what actions to take.
   *
   * @param event - The event to process
   * @param state - Read-only state snapshot for accessing module state and lookups
   */
  onProcess(event: ProcessEvent, state: ProcessState): Promise<EventResponse>;

  /**
   * Handle agent speech (if registered as speech handler).
   * Called when an agent produces text output.
   */
  onAgentSpeech?(
    agentName: string,
    content: ContentBlock[],
    context: SpeechContext
  ): Promise<void>;
}

/**
 * Context provided to modules for interacting with the framework.
 */
export interface ModuleContext {
  /**
   * Get persistent state for this module.
   * State is namespaced to the module.
   */
  getState<T>(): T | null;

  /**
   * Set persistent state for this module.
   */
  setState<T>(state: T): void;

  /**
   * Process queue for pushing events from external listeners.
   */
  readonly queue: ProcessQueue;

  /**
   * Get another module by name.
   */
  getModule<T extends Module>(name: string): T | null;

  /**
   * Add a message to the conversation.
   */
  addMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata & { external?: ExternalIdRef }
  ): MessageId;

  /**
   * Edit a message.
   */
  editMessage(id: MessageId, content: ContentBlock[]): void;

  /**
   * Remove a message.
   */
  removeMessage(id: MessageId): void;

  /**
   * Find a message by external ID.
   */
  findMessageByExternalId(source: string, externalId: string): MessageId | null;

  /**
   * Get info about all agents.
   */
  getAgents(): AgentInfo[];

  /**
   * Get all currently available tools.
   */
  getActiveTools(): ToolDefinition[];

  /**
   * Whether this is a restart (state existed) vs fresh start.
   */
  readonly isRestart: boolean;

  /**
   * Register this module as a speech handler for agents.
   * @param agents - '*' for all agents, or array of agent names
   * @param options - Speech handler options
   */
  registerSpeechHandler(
    agents: '*' | string[],
    options?: SpeechHandlerOptions
  ): void;

  /**
   * Unregister this module as a speech handler.
   */
  unregisterSpeechHandler(): void;
}

/**
 * Read-only state snapshot provided to modules during event processing.
 * State writes happen via EventResponse, not through this interface.
 */
export interface ProcessState {
  /**
   * Get this module's state.
   */
  getState<T>(): T | null;

  /**
   * Get another module's state by name.
   */
  getModuleState<T>(name: string): T | null;

  /**
   * Find a message by external ID.
   */
  findMessageByExternalId(source: string, externalId: string): MessageId | null;

  /**
   * Get info about all agents.
   */
  getAgents(): AgentInfo[];

  /**
   * Get all currently available tools.
   */
  getActiveTools(): ToolDefinition[];

  /**
   * Queue for emitting follow-up events.
   */
  readonly queue: ProcessQueue;
}

/**
 * Reference to an external system's ID.
 */
export interface ExternalIdRef {
  source: string;
  id: string;
}

/**
 * Process queue interface for modules.
 */
export interface ProcessQueue {
  /**
   * Push a process event to the queue.
   */
  push(event: ProcessEvent): void;
}

/**
 * Basic info about an agent.
 */
export interface AgentInfo {
  name: string;
  model: string;
  status: AgentStatus;
}

/**
 * Agent execution status.
 */
export type AgentStatus = 'idle' | 'inferring' | 'waiting_for_tools' | 'ready';

/**
 * Response from a module's event handler.
 */
export interface EventResponse {
  /**
   * Messages to add to the conversation.
   */
  addMessages?: NewMessage[];

  /**
   * Messages to edit.
   */
  editMessages?: MessageEdit[];

  /**
   * Messages to remove.
   */
  removeMessages?: MessageId[];

  /**
   * Request inference.
   * - true: request for all agents
   * - string[]: request for specific agents
   * - false/undefined: no request
   */
  requestInference?: boolean | string[];

  /**
   * Signal that this module's tools have changed.
   */
  toolsChanged?: boolean;

  /**
   * Module state update. Applied atomically with message operations.
   * The framework will call setState() with this value after applying
   * message changes, ensuring consistent state.
   */
  stateUpdate?: unknown;
}

/**
 * A new message to add.
 */
export interface NewMessage {
  participant: string;
  content: ContentBlock[];
  metadata?: MessageMetadata & { external?: ExternalIdRef };
}

/**
 * An edit to an existing message.
 */
export interface MessageEdit {
  messageId: MessageId;
  content: ContentBlock[];
}

// ============================================================================
// Speech Handler Types
// ============================================================================

/**
 * Context provided to speech handlers.
 */
export interface SpeechContext {
  /**
   * Whether this is a complete turn or tool calls are pending.
   * If false, more output may follow after tool results.
   */
  turnComplete: boolean;

  /**
   * The inference request that triggered this speech.
   */
  trigger: {
    reason: string;
    source: string;
    timestamp: number;
  };
}

/**
 * Options for speech handler registration.
 */
export interface SpeechHandlerOptions {
  /**
   * If true, add to existing handlers rather than replacing.
   * Multiple handlers will all receive speech.
   */
  additive?: boolean;

  /**
   * Priority for handler ordering (higher = called first).
   * Default: 0
   */
  priority?: number;
}
