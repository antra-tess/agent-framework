/**
 * Mock host script - runs the agent framework with canned responses
 * 
 * No API key needed! Uses MockAdapter for testing the framework
 * without making real LLM calls.
 *
 * Usage:
 *   npx tsx examples/host-mock.ts
 */

import { Membrane, MockAdapter } from '@animalabs/membrane';
import { AgentFramework, ApiServer, ApiModule } from '../src/index.js';

async function main() {
  console.log('Starting agent framework with MOCK adapter...');
  console.log('(No real LLM calls will be made)\n');

  // Create mock adapter with some canned responses
  const mockAdapter = new MockAdapter({
    // First few responses are specific
    responseQueue: [
      'Hello! I am a mock agent running in test mode. The framework is working correctly!',
      'I received your message. Since this is a mock adapter, I am returning pre-configured responses.',
      'This is the third canned response. After this, I will return the default response.',
    ],
    // Default response after queue is exhausted
    defaultResponse: 'Mock response: The system is operational. This is a test environment.',
    // Simulate realistic streaming
    streamChunkDelayMs: 15,
    streamChunkSize: 8,
  });

  // Create membrane with mock adapter
  const membrane = new Membrane(mockAdapter, {
    assistantParticipant: 'assistant',
  });

  // Create framework
  const framework = await AgentFramework.create({
    storePath: './data/mock-agent-store',
    membrane,
    agents: [
      {
        name: 'assistant',
        model: 'mock-model', // Model name doesn't matter for mock
        systemPrompt: `You are a helpful assistant running in TEST MODE.
This is a mock environment - no real LLM calls are being made.

Your responses are pre-configured for testing the framework.`,
      },
    ],
    modules: [new ApiModule()],
  });

  // Add event listener for debugging
  framework.on((event) => {
    switch (event.type) {
      case 'inference:start':
        console.log(`[MOCK] Inference starting for ${event.agentName}`);
        break;
      case 'inference:complete':
        console.log(`[MOCK] Inference complete (${event.durationMs}ms)`);
        break;
      case 'inference:error':
        console.log(`[ERROR] ${event.error.message}`);
        break;
      case 'message:added':
        console.log(`[MSG] Message added: ${event.messageId}`);
        break;
      default:
        // Ignore other events
        break;
    }
  });

  // Start framework loop
  framework.start();
  console.log('Framework started (mock mode)');

  // Start API server
  const api = new ApiServer(framework, { port: 8765 });
  await api.start();
  console.log('API server listening on ws://localhost:8765/ws');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await api.stop();
    await framework.stop();
    process.exit(0);
  });

  console.log('\n========================================');
  console.log('MOCK MODE - No API key required!');
  console.log('========================================');
  console.log('\nYou can now:');
  console.log('1. Connect MCP tools (agent-framework in Cursor)');
  console.log('2. Send messages via agent_send_message');
  console.log('3. Watch mock responses flow through');
  console.log('\nPress Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
