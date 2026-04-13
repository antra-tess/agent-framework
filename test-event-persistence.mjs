/**
 * Test script for event persistence
 */

import { JsStore } from '@animalabs/chronicle';
import { Membrane, AnthropicAdapter } from '@animalabs/membrane';
import { AgentFramework, ApiModule } from './dist/index.js';
import { rm } from 'fs/promises';

const TEST_STORE_PATH = './test-event-store';

// Clean up any previous test data
try {
  await rm(TEST_STORE_PATH, { recursive: true });
} catch {
  // Ignore if doesn't exist
}

console.log('=== Test 1: Create framework and push events ===\n');

// Create framework
const adapter = new AnthropicAdapter({});
const membrane = new Membrane(adapter);

let framework = await AgentFramework.create({
  storePath: TEST_STORE_PATH,
  membrane,
  agents: [
    {
      name: 'test-agent',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are a test agent.',
    },
  ],
  modules: [new ApiModule()],
});

// Listen for events
framework.on((event) => {
  if (event.type === 'event:persisted') {
    console.log(`  Event persisted: ${event.eventId} (seq: ${event.sequence})`);
  }
});

framework.start();

// Push some events
console.log('Pushing events...');
const eventId1 = framework.pushEvent({
  type: 'api:message',
  participant: 'user',
  content: 'Hello, this is message 1',
});
console.log(`  Pushed event 1: ${eventId1}`);

const eventId2 = framework.pushEvent({
  type: 'api:message',
  participant: 'user',
  content: 'Hello, this is message 2',
});
console.log(`  Pushed event 2: ${eventId2}`);

const eventId3 = framework.pushEvent({
  type: 'api:inference-request',
  agentName: 'test-agent',
  reason: 'test',
});
console.log(`  Pushed event 3: ${eventId3}`);

// Query events
console.log('\nQuerying events...');
const allEvents = framework.queryEvents();
console.log(`  Total events: ${allEvents.length}`);
allEvents.forEach((e, i) => {
  console.log(`  [${i}] ${e.type} (id: ${e.id}, seq: ${e.sequence})`);
});

// Query with filter
const messageEvents = framework.queryEvents({ types: ['api:message'] });
console.log(`\n  api:message events: ${messageEvents.length}`);

const inferenceEvents = framework.queryEvents({ types: ['api:inference-request'] });
console.log(`  api:inference-request events: ${inferenceEvents.length}`);

// Query with glob pattern
const apiEvents = framework.queryEvents({ types: ['api:*'] });
console.log(`  api:* events: ${apiEvents.length}`);

// Stop framework
await framework.stop();
console.log('\nFramework stopped.\n');

console.log('=== Test 2: Restart framework and verify persistence ===\n');

// Create a new framework with the same store
const membrane2 = new Membrane(adapter);
framework = await AgentFramework.create({
  storePath: TEST_STORE_PATH,
  membrane: membrane2,
  agents: [
    {
      name: 'test-agent',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are a test agent.',
    },
  ],
  modules: [new ApiModule()],
});

// Query events - they should still be there!
console.log('Querying events after restart...');
const persistedEvents = framework.queryEvents();
console.log(`  Total events: ${persistedEvents.length}`);
persistedEvents.forEach((e, i) => {
  console.log(`  [${i}] ${e.type} (id: ${e.id}, seq: ${e.sequence})`);
});

// Verify event content
const firstEvent = persistedEvents.find(e => e.id === eventId1);
if (firstEvent) {
  console.log('\n  First event payload:', JSON.stringify(firstEvent.payload, null, 2));
}

// Stop and cleanup
await framework.stop();

// Verify counts match
const expectedCount = 3;
if (persistedEvents.length === expectedCount) {
  console.log(`\n✅ SUCCESS: All ${expectedCount} events persisted and recovered!`);
} else {
  console.log(`\n❌ FAIL: Expected ${expectedCount} events, got ${persistedEvents.length}`);
  process.exit(1);
}

// Cleanup test data
try {
  await rm(TEST_STORE_PATH, { recursive: true });
} catch {
  // Ignore
}
