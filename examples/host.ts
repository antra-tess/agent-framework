/**
 * Example host script - runs the agent framework with API server
 *
 * Usage:
 *   npx tsx examples/host.ts
 */

import { Membrane, AnthropicAdapter } from '@animalabs/membrane';
import { AgentFramework, ApiServer, ApiModule } from '../src/index.js';

async function main() {
  console.log('Starting agent framework...');

  // Create membrane with Anthropic adapter
  const adapter = new AnthropicAdapter({
    // Uses ANTHROPIC_API_KEY env var by default
  });
  const membrane = new Membrane(adapter, {
    // Tell membrane which participant name is the assistant
    assistantParticipant: 'assistant',
  });

  // Create framework
  const framework = await AgentFramework.create({
    storePath: './data/agent-store',
    membrane,
    agents: [
      {
        name: 'assistant',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: `You are a helpful assistant. You can have conversations and help with various tasks.

Keep your responses concise and helpful.`,
      },
    ],
    modules: [new ApiModule()],
  });

  // Add event listener for debugging
  framework.on((event) => {
    if (event.type === 'inference:error') {
      console.log('[ERROR]', JSON.stringify(event, null, 2));
    } else {
      console.log('[EVENT]', event.type);
    }
  });

  // Start framework loop
  framework.start();
  console.log('Framework started');

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

  console.log('\nReady! You can now connect via MCP or WebSocket.');
  console.log('Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
