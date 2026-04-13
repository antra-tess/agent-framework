import type { Membrane, NormalizedMessage, NormalizedRequest, ContentBlock, YieldingStream } from '@animalabs/membrane';
import { isAbortedResponse } from '@animalabs/membrane';

export interface StartStreamResult {
  stream: YieldingStream;
  request: NormalizedRequest;
}
import type { ContextManager, TokenBudget, ContextInjection, CompileResult } from '@animalabs/context-manager';
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
  InferenceOptions,
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
  private _inferenceStartedAt = 0;
  private _streamId = 0;
  lastStreamInputTokens = 0;
  maxStreamTokens: number;
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
    this.maxStreamTokens = config.maxStreamTokens ?? 150_000;
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
   * Monotonically increasing stream generation counter.
   * Used to guard stale driveStream handlers after a budget restart.
   */
  get streamId(): number {
    return this._streamId;
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

  // ==========================================================================
  // Composable Steps
  // ==========================================================================

  /**
   * Compile the context without injections.
   * Step 1 of the inference pipeline — callers can inspect/modify the result
   * before building a request.
   */
  async compileContext(budget?: TokenBudget): Promise<CompileResult> {
    return this.contextManager.compile(budget);
  }

  /**
   * Compile the context with injections.
   * Same as compileContext but forwards injections (e.g. from MCPL servers)
   * to the context manager so they are merged into the compiled messages.
   */
  async compileWithInjections(
    budget?: TokenBudget,
    injections?: ContextInjection[]
  ): Promise<CompileResult> {
    return this.contextManager.compile(budget, injections);
  }

  // ==========================================================================
  // Inference (backward-compatible)
  // ==========================================================================

  /**
   * Run inference and return result with tool calls and speech content.
   * Updates agent state during execution.
   */
  async runInference(
    availableTools: ToolDefinition[],
    budget?: TokenBudget,
    options: InferenceOptions = {}
  ): Promise<InferenceResult> {
    return this.runInferenceWithInjections(availableTools, undefined, budget, options);
  }

  /**
   * Run inference with context injections.
   * Same as runInference but passes injections through to compile.
   */
  async runInferenceWithInjections(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget,
    options?: InferenceOptions
  ): Promise<InferenceResult> {
    if (this._state.status === 'inferring') {
      throw new Error(`Agent ${this.name} is already inferring`);
    }

    if (this._state.status === 'waiting_for_tools') {
      throw new Error(`Agent ${this.name} is waiting for tool results`);
    }

    // Filter tools to only allowed ones
    const tools = availableTools.filter((t) => this.canUseTool(t.name));

    // Compile context (with optional injections)
    const { messages, systemInjections } = await this.compileWithInjections(budget, injections);

    // If we have pending tool results, add them
    if (this._state.status === 'ready') {
      const toolResultMessages = this.buildToolResultMessages(this._state.toolResults);
      messages.push(...toolResultMessages);
    }

    const request: NormalizedRequest = {
      messages,
      system: this.buildSystemPrompt(systemInjections),
      config: {
        model: this.model,
        maxTokens: this.maxTokens,
        temperature: this.temperature,
      },
      tools: tools.length > 0 ? tools : undefined,
      assistantParticipant: this.name,
    };

    const abortController = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) {
        abortController.abort();
      } else {
        options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    // Set state to inferring
    this._inferenceStartedAt = Date.now();
    const inferencePromise = this.doInference(request, abortController.signal);
    this._state = { status: 'inferring', promise: inferencePromise, abortController };

    try {
      const result = await inferencePromise;

      if (result.aborted) {
        this._state = { status: 'idle' };
        return result;
      }

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
  ): Promise<StartStreamResult> {
    return this.startStreamWithInjections(availableTools, undefined, budget);
  }

  /**
   * Start a yielding stream with context injections.
   * Same as startStream but passes injections through to compile.
   */
  async startStreamWithInjections(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget
  ): Promise<StartStreamResult> {
    if (this._state.status !== 'idle') {
      throw new Error(`Agent ${this.name} cannot start stream in state ${this._state.status}`);
    }

    this._streamId++;
    this._inferenceStartedAt = Date.now();
    this.lastStreamInputTokens = 0;

    let { messages, systemInjections } = await this.compileWithInjections(budget, injections);

    // Safety: ensure messages don't end with an assistant message.
    // Some models reject trailing assistant messages ("prefill not supported"),
    // and after context compression a stale assistant turn can end up last.
    if (messages.length > 0 && messages[messages.length - 1]!.participant === this.name) {
      messages = [...messages, {
        participant: 'user',
        content: [{ type: 'text', text: '[Continue]' }],
      }];
    }

    const request: NormalizedRequest = {
      messages,
      system: this.buildSystemPrompt(systemInjections),
      config: {
        model: this.model,
        maxTokens: this.maxTokens,
        temperature: this.temperature,
      },
      tools: availableTools.length > 0 ? availableTools : undefined,
      promptCaching: true,
      assistantParticipant: this.name,
    };

    const stream = this.membrane.streamYielding(request, {
      emitTokens: true,
      emitBlocks: false,
      emitUsage: true,
    });

    this._state = { status: 'streaming', stream };
    return { stream, request };
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

  /**
   * Build the effective system prompt, appending any system-position injections.
   */
  private buildSystemPrompt(systemInjections: ContentBlock[]): string {
    if (systemInjections.length === 0) {
      return this.systemPrompt;
    }

    const injectedText = systemInjections
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map((block) => block.text);

    if (injectedText.length === 0) {
      return this.systemPrompt;
    }

    return this.systemPrompt + '\n' + injectedText.join('\n');
  }

  abortInference(reason?: string): { aborted: true; durationMs: number } | false {
    if (this._state.status === 'inferring') {
      const durationMs = Date.now() - this._inferenceStartedAt;
      this._state.abortController.abort(reason);
      return { aborted: true, durationMs };
    }

    if (this._state.status === 'streaming' ||
        (this._state.status === 'waiting_for_tools' && this._state.stream)) {
      const durationMs = Date.now() - this._inferenceStartedAt;
      this.cancelStream();
      return { aborted: true, durationMs };
    }

    return false;
  }

  private async doInference(
    request: NormalizedRequest,
    signal?: AbortSignal
  ): Promise<InferenceResult> {
    const response = await this.membrane.stream(request, { signal });

    if (isAbortedResponse(response)) {
      const partialContent = response.partialContent ?? [];
      const { toolCalls, speechContent } = this.extractToolCallsAndSpeech(partialContent);
      return {
        toolCalls,
        speechContent,
        usage: response.partialUsage,
        stopReason: 'abort',
        aborted: true,
        abortReason: response.reason,
      };
    }

    const { toolCalls, speechContent } = this.extractToolCallsAndSpeech(response.content);

    // Add assistant response to context
    this.contextManager.addMessage(this.name, response.content);

    return {
      toolCalls,
      speechContent,
      raw: response.raw,
      usage: response.usage,
      stopReason: response.stopReason,
    };
  }

  private extractToolCallsAndSpeech(content: ContentBlock[]): {
    toolCalls: ToolCall[];
    speechContent: ContentBlock[];
  } {
    const toolCalls: ToolCall[] = [];
    const speechContent: ContentBlock[] = [];

    for (const block of content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      } else if (block.type === 'text') {
        speechContent.push(block);
      }
    }

    return { toolCalls, speechContent };
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
