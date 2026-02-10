import type { Membrane, NormalizedMessage, NormalizedRequest, ContentBlock, YieldingStream } from 'membrane';
import type { ContextManager, TokenBudget } from '@connectome/context-manager';
import type {
  AgentConfig,
  AgentState,
  PendingToolCall,
  CompletedToolCall,
  ToolCallId,
  ToolCall,
  ToolResult,
  ToolDefinition,
  AgentInfo,
  InferenceResult,
} from './types/index.js';

/**
 * An agent wraps a context manager and manages inference state.
 */
export class Agent {
  readonly name: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly allowedTools: 'all' | string[];
  readonly triggerSources: 'all' | string[];
  readonly maxTokens: number;
  readonly temperature: number;

  private _state: AgentState = { status: 'idle' };
  private contextManager: ContextManager;
  private membrane: Membrane;

  constructor(
    config: AgentConfig,
    contextManager: ContextManager,
    membrane: Membrane
  ) {
    this.name = config.name;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools ?? 'all';
    this.triggerSources = config.triggerSources ?? 'all';
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 1;
    this.contextManager = contextManager;
    this.membrane = membrane;
  }

  /**
   * Get current agent state.
   */
  get state(): AgentState {
    return this._state;
  }

  /**
   * Get agent info.
   */
  get info(): AgentInfo {
    return {
      name: this.name,
      model: this.model,
      status: this._state.status,
    };
  }

  /**
   * Check if agent can use a specific tool.
   */
  canUseTool(toolName: string): boolean {
    if (this.allowedTools === 'all') {
      return true;
    }
    return this.allowedTools.includes(toolName);
  }

  /**
   * Check if a source can trigger inference for this agent.
   */
  canBeTriggeredBy(source: string): boolean {
    if (this.triggerSources === 'all') {
      return true;
    }
    return this.triggerSources.includes(source);
  }

  /**
   * Run inference and return result with tool calls and speech content.
   * Updates agent state during execution.
   */
  async runInference(
    availableTools: ToolDefinition[],
    budget?: TokenBudget
  ): Promise<InferenceResult> {
    if (this._state.status === 'inferring') {
      throw new Error(`Agent ${this.name} is already inferring`);
    }

    if (this._state.status === 'waiting_for_tools') {
      throw new Error(`Agent ${this.name} is waiting for tool results`);
    }

    // Filter tools to only allowed ones
    const tools = availableTools.filter((t) => this.canUseTool(t.name));

    // Build request
    const messages = await this.contextManager.compile(budget);

    // If we have pending tool results, add them
    if (this._state.status === 'ready') {
      const toolResultMessages = this.buildToolResultMessages(this._state.toolResults);
      messages.push(...toolResultMessages);
    }

    const request: NormalizedRequest = {
      messages,
      system: this.systemPrompt,
      config: {
        model: this.model,
        maxTokens: this.maxTokens,
        temperature: this.temperature,
      },
      tools: tools.length > 0 ? tools : undefined,
    };

    // Set state to inferring
    const inferencePromise = this.doInference(request);
    this._state = { status: 'inferring', promise: inferencePromise };

    try {
      const result = await inferencePromise;

      if (result.toolCalls.length > 0) {
        // Waiting for tool results
        const pending = new Map<ToolCallId, PendingToolCall>();
        for (const call of result.toolCalls) {
          pending.set(call.id, {
            id: call.id,
            name: call.name,
            input: call.input,
            startedAt: Date.now(),
          });
        }
        this._state = { status: 'waiting_for_tools', pending, completed: [] };
      } else {
        // Done, back to idle
        this._state = { status: 'idle' };
      }

      return result;
    } catch (error) {
      // On error, go back to idle
      this._state = { status: 'idle' };
      throw error;
    }
  }

  /**
   * Provide a tool result.
   */
  provideToolResult(callId: ToolCallId, result: ToolResult): void {
    if (this._state.status !== 'waiting_for_tools') {
      throw new Error(`Agent ${this.name} is not waiting for tools`);
    }

    const pending = this._state.pending.get(callId);
    if (!pending) {
      throw new Error(`Unknown tool call: ${callId}`);
    }

    // Move from pending to completed
    const completed: CompletedToolCall = {
      id: pending.id,
      name: pending.name,
      input: pending.input,
      result,
      durationMs: Date.now() - pending.startedAt,
    };

    this._state.pending.delete(callId);
    this._state.completed.push(completed);

    // If all tools done, transition to ready
    if (this._state.pending.size === 0) {
      this._state = { status: 'ready', toolResults: this._state.completed, stream: this._state.stream };
    }
  }

  /**
   * Start a yielding stream for inference.
   * Returns the stream — the caller (framework) iterates it.
   */
  async startStream(
    availableTools: ToolDefinition[],
    budget?: TokenBudget
  ): Promise<YieldingStream> {
    if (this._state.status !== 'idle') {
      throw new Error(`Agent ${this.name} cannot start stream in state ${this._state.status}`);
    }

    const messages = await this.contextManager.compile(budget);

    const request: NormalizedRequest = {
      messages,
      system: this.systemPrompt,
      config: {
        model: this.model,
        maxTokens: this.maxTokens,
        temperature: this.temperature,
      },
      tools: availableTools.length > 0 ? availableTools : undefined,
    };

    const stream = this.membrane.streamYielding(request, {
      emitTokens: true,
      emitBlocks: false,
      emitUsage: true,
    });

    this._state = { status: 'streaming', stream };
    return stream;
  }

  /**
   * Transition to waiting_for_tools when stream yields tool calls.
   * Called by framework's driveStream.
   */
  enterWaitingForTools(calls: ToolCall[], stream: YieldingStream): void {
    const pending = new Map<ToolCallId, PendingToolCall>();
    for (const call of calls) {
      pending.set(call.id, {
        id: call.id,
        name: call.name,
        input: call.input,
        startedAt: Date.now(),
      });
    }
    this._state = { status: 'waiting_for_tools', pending, completed: [], stream };
  }

  /**
   * Add an assistant response to context.
   * Called by framework when stream completes.
   */
  addAssistantResponse(content: ContentBlock[]): void {
    this.contextManager.addMessage(this.name, content);
  }

  /**
   * Transition back to streaming state after tool results are provided.
   */
  setStreaming(stream: YieldingStream): void {
    this._state = { status: 'streaming', stream };
  }

  /**
   * Cancel any active stream and reset to idle.
   */
  cancelStream(): void {
    if (this._state.status === 'streaming') {
      this._state.stream.cancel();
    } else if (this._state.status === 'waiting_for_tools' && this._state.stream) {
      this._state.stream.cancel();
    }
    this._state = { status: 'idle' };
  }

  /**
   * Check if agent has pending tool calls.
   */
  hasPendingTools(): boolean {
    return this._state.status === 'waiting_for_tools' && this._state.pending.size > 0;
  }

  /**
   * Get pending tool call IDs.
   */
  getPendingToolIds(): ToolCallId[] {
    if (this._state.status !== 'waiting_for_tools') {
      return [];
    }
    return Array.from(this._state.pending.keys());
  }

  /**
   * Reset agent to idle state.
   */
  reset(): void {
    this._state = { status: 'idle' };
  }

  /**
   * Get the context manager.
   */
  getContextManager(): ContextManager {
    return this.contextManager;
  }

  private async doInference(request: NormalizedRequest): Promise<InferenceResult> {
    const response = await this.membrane.complete(request);

    // Membrane normalizes both native and XML modes to the same block structure.
    // We receive clean content blocks: text (no XML), tool_use, thinking, etc.
    const toolCalls = response.toolCalls;

    // Extract speech content - text blocks that should be shown to users.
    // Thinking blocks are internal reasoning, not speech.
    // Tool_use blocks are handled separately via toolCalls.
    const speechContent = response.content.filter(
      (block): block is ContentBlock & { type: 'text' } => block.type === 'text'
    );

    // Add assistant response to context (store full response including tool calls)
    this.contextManager.addMessage(this.name, response.content);

    return {
      toolCalls,
      speechContent,
      raw: response.raw,
      usage: response.usage,
      stopReason: response.stopReason,
    };
  }

  private buildToolResultMessages(results: CompletedToolCall[]): NormalizedMessage[] {
    // Tool results go as a user message with tool_result blocks
    const content = results.map((r) => ({
      type: 'tool_result' as const,
      toolUseId: r.id,
      content: r.result.isError
        ? r.result.error ?? 'Unknown error'
        : JSON.stringify(r.result.data),
      isError: r.result.isError,
    }));

    return [{
      participant: 'user',
      content,
    }];
  }
}
