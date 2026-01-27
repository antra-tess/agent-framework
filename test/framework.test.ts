/**
 * Agent framework integration tests
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse, ContentBlock } from 'membrane';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '../src/index.js';
import { AgentFramework, ProcessQueueImpl } from '../src/index.js';

// ============================================================================
// Mock Membrane - minimal interface that framework needs
// ============================================================================

interface MinimalMembrane {
  complete(request: NormalizedRequest): Promise<NormalizedResponse>;
}

function createMockResponse(
  content: ContentBlock[],
  stopReason: NormalizedResponse['stopReason'] = 'end_turn'
): NormalizedResponse {
  const rawText = content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    content,
    stopReason,
    rawAssistantText: rawText,
    toolCalls: [],
    toolResults: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    details: {
      stop: { reason: stopReason, wasTruncated: false },
      usage: { inputTokens: 10, outputTokens: 5 },
      timing: { totalDurationMs: 100, attempts: 1 },
      model: { requested: 'test', actual: 'test', provider: 'mock' },
      cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
    },
    raw: { request: {}, response: {} },
  };
}

class MockMembrane implements MinimalMembrane {
  responses: NormalizedResponse[] = [];
  calls: NormalizedRequest[] = [];
  private responseIndex = 0;

  pushResponse(response: NormalizedResponse): void {
    this.responses.push(response);
  }

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls.push(request);
    if (this.responseIndex >= this.responses.length) {
      // Default response
      return createMockResponse([{ type: 'text', text: 'Default response' }]);
    }
    return this.responses[this.responseIndex++];
  }

  // Cast helper - use this when passing to framework
  asMembrane(): import('membrane').Membrane {
    return this as unknown as import('membrane').Membrane;
  }
}

// ============================================================================
// Mock Module
// ============================================================================

class TestModule implements Module {
  readonly name = 'test';
  ctx: ModuleContext | null = null;
  events: ProcessEvent[] = [];
  toolCalls: ToolCall[] = [];

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'echo',
        description: 'Echoes the input',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message to echo' },
          },
          required: ['message'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.toolCalls.push(call);
    if (call.name === 'echo') {
      const input = call.input as { message: string };
      return { success: true, data: { echoed: input.message } };
    }
    return { success: false, error: 'Unknown tool', isError: true };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    this.events.push(event);

    // Handle external message by requesting inference
    if (event.type === 'external-message') {
      return {
        addMessages: [
          {
            participant: 'User',
            content: [{ type: 'text', text: String(event.content) }],
          },
        ],
        requestInference: true,
      };
    }

    return {};
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('ProcessQueueImpl', () => {
  it('should push and pop events', () => {
    const queue = new ProcessQueueImpl();
    const event: ProcessEvent = {
      type: 'timer-fired',
      timerId: 'test',
      reason: 'test',
    };

    queue.push(event);
    assert.strictEqual(queue.depth, 1);
    assert.strictEqual(queue.isEmpty, false);

    const popped = queue.tryPop();
    assert.deepStrictEqual(popped, event);
    assert.strictEqual(queue.depth, 0);
    assert.strictEqual(queue.isEmpty, true);
  });

  it('should return null when queue is empty', () => {
    const queue = new ProcessQueueImpl();
    assert.strictEqual(queue.tryPop(), null);
  });

  it('should peek without removing', () => {
    const queue = new ProcessQueueImpl();
    const event: ProcessEvent = {
      type: 'timer-fired',
      timerId: 'test',
      reason: 'test',
    };

    queue.push(event);
    assert.deepStrictEqual(queue.peek(), event);
    assert.strictEqual(queue.depth, 1);
  });

  it('should clear all events', () => {
    const queue = new ProcessQueueImpl();
    queue.push({ type: 'timer-fired', timerId: '1', reason: 'test' });
    queue.push({ type: 'timer-fired', timerId: '2', reason: 'test' });

    queue.clear();
    assert.strictEqual(queue.isEmpty, true);
  });

  it('should close and prevent further pushes', () => {
    const queue = new ProcessQueueImpl();
    queue.close();

    assert.throws(() => {
      queue.push({ type: 'timer-fired', timerId: 'test', reason: 'test' });
    }, /Queue is closed/);
  });
});

describe('AgentFramework', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-framework-test-'));
    membrane = new MockMembrane();
  });

  it('should create framework with agents and modules', async () => {
    const testModule = new TestModule();

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'You are a helpful assistant.',
        },
      ],
      modules: [testModule],
    });

    assert.notStrictEqual(framework.getAgent('assistant'), null);
    assert.deepStrictEqual(framework.getAllAgents().map((a) => a.name), ['assistant']);
    assert.notStrictEqual(testModule.ctx, null);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should route external messages and trigger inference', async () => {
    const testModule = new TestModule();

    // Set up response
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello! How can I help?' }]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'You are a helpful assistant.',
        },
      ],
      modules: [testModule],
    });

    // Push an external message event
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Hello!',
      metadata: {},
    });

    // Run until idle
    await framework.runUntilIdle();

    // Check that module received the event
    assert.strictEqual(testModule.events.length, 1);
    assert.strictEqual(testModule.events[0].type, 'external-message');

    // Check that membrane was called
    assert.strictEqual(membrane.calls.length, 1);
    assert.strictEqual(membrane.calls[0].system, 'You are a helpful assistant.');

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should handle tool calls', async () => {
    const testModule = new TestModule();

    // First response with tool call
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Let me echo that for you.' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'test:echo',
        input: { message: 'test message' },
      },
    ], 'tool_use'));

    // Second response after tool result
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'The echoed message is: test message' },
    ]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'You are a helpful assistant.',
        },
      ],
      modules: [testModule],
    });

    // Push message and run
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Echo this!',
      metadata: {},
    });

    await framework.runUntilIdle();

    // Check tool was called
    assert.strictEqual(testModule.toolCalls.length, 1);
    assert.strictEqual(testModule.toolCalls[0].name, 'echo');
    assert.deepStrictEqual(testModule.toolCalls[0].input, { message: 'test message' });

    // Check membrane was called twice (initial + after tool result)
    assert.strictEqual(membrane.calls.length, 2);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should emit framework events', async () => {
    const testModule = new TestModule();
    const events: string[] = [];

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello!' }]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'Test',
        },
      ],
      modules: [testModule],
    });

    framework.onTrace((event) => {
      events.push(event.type);
    });

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Hello',
      metadata: {},
    });

    await framework.runUntilIdle();

    assert.ok(events.includes('process:received'), 'Should emit process:received');
    assert.ok(events.includes('inference:started'), 'Should emit inference:started');
    assert.ok(events.includes('inference:completed'), 'Should emit inference:completed');
    assert.ok(events.includes('message:added'), 'Should emit message:added');

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should filter tools by agent allowedTools', async () => {
    const testModule = new TestModule();

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'No tools available' },
    ]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'Test',
          allowedTools: ['nonexistent:tool'], // Won't match test:echo
        },
      ],
      modules: [testModule],
    });

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Hello',
      metadata: {},
    });

    await framework.runUntilIdle();

    // Should have no tools in the request
    assert.strictEqual(membrane.calls[0].tools, undefined);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should support adding and removing modules at runtime', async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'Test',
        },
      ],
      modules: [],
    });

    const testModule = new TestModule();
    await framework.addModule(testModule);
    assert.notStrictEqual(testModule.ctx, null);

    await framework.removeModule('test');
    assert.strictEqual(testModule.ctx, null);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should share store when provided', async () => {
    // This test verifies that app-owned stores work
    const { JsStore } = await import('chronicle');
    const store = JsStore.openOrCreate({ path: join(tempDir, 'shared.chronicle') });

    const framework = await AgentFramework.create({
      store,
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'Test',
        },
      ],
      modules: [],
    });

    // Framework should work
    assert.notStrictEqual(framework.getStore(), null);
    assert.strictEqual(framework.getStore(), store);

    await framework.stop();
    // Store should still be open (framework doesn't own it)
    // We can close it ourselves
    store.close();

    rmSync(tempDir, { recursive: true });
  });
});

describe('Module state persistence', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-framework-test-'));
    membrane = new MockMembrane();
  });

  it('should persist and restore module state', async () => {
    class StatefulModule implements Module {
      readonly name = 'stateful';
      ctx: ModuleContext | null = null;

      async start(ctx: ModuleContext): Promise<void> {
        this.ctx = ctx;
        // Set initial state
        const existing = ctx.getState<{ count: number }>();
        if (!existing) {
          ctx.setState({ count: 1 });
        } else {
          ctx.setState({ count: existing.count + 1 });
        }
      }

      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] { return []; }
      async handleToolCall(): Promise<ToolResult> {
        return { success: false, error: 'No tools', isError: true };
      }
      async onProcess(): Promise<EventResponse> { return {}; }
    }

    const storePath = join(tempDir, 'state.chronicle');

    // First run
    const module1 = new StatefulModule();
    const framework1 = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'a', model: 'm', systemPrompt: 's' }],
      modules: [module1],
    });
    assert.deepStrictEqual(module1.ctx?.getState<{ count: number }>()?.count, 1);
    await framework1.stop();

    // Second run - state should be restored
    const module2 = new StatefulModule();
    const framework2 = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'a', model: 'm', systemPrompt: 's' }],
      modules: [module2],
    });
    assert.deepStrictEqual(module2.ctx?.getState<{ count: number }>()?.count, 2);
    await framework2.stop();

    rmSync(tempDir, { recursive: true });
  });

  it('should track external IDs', async () => {
    class IdTrackingModule implements Module {
      readonly name = 'idtracker';
      ctx: ModuleContext | null = null;

      async start(ctx: ModuleContext): Promise<void> {
        this.ctx = ctx;
      }

      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] { return []; }
      async handleToolCall(): Promise<ToolResult> {
        return { success: false, error: 'No tools', isError: true };
      }
      async onProcess(): Promise<EventResponse> { return {}; }
    }

    const module = new IdTrackingModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'ids.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'a', model: 'm', systemPrompt: 's' }],
      modules: [module],
    });

    // Add a message with external ID
    const msgId = module.ctx!.addMessage(
      'User',
      [{ type: 'text', text: 'Hello from Discord' }],
      { external: { source: 'discord', id: 'msg123' } }
    );

    // Should be able to look it up
    const found = module.ctx!.findMessageByExternalId('discord', 'msg123');
    assert.strictEqual(found, msgId);

    // Unknown ID should return null
    const notFound = module.ctx!.findMessageByExternalId('discord', 'unknown');
    assert.strictEqual(notFound, null);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });
});
