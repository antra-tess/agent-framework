import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

type TypingCall = {
  serverId: string;
  channelId: string;
  metadata?: Record<string, unknown>;
  op?: 'start' | 'stop';
};

function makeRegistry() {
  const calls: TypingCall[] = [];
  const sendTypingFn = (
    serverId: string,
    channelId: string,
    metadata?: Record<string, unknown>,
    op?: 'start' | 'stop',
  ) => {
    calls.push({ serverId, channelId, metadata, op });
  };

  const registry = new ChannelRegistry(
    {} as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { sendTypingFn },
  );

  // Register a channel directly via the private map — avoids the full
  // channel-incoming event plumbing, which isn't under test here.
  (registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: { id: string }; open: boolean }>;
  }).channels.set('srv:ch1', {
    serverId: 'srv',
    descriptor: { id: 'ch1' },
    open: true,
  });

  return { registry, calls };
}

test('stopTyping(channelId) suppresses stop when no interval was active', () => {
  const { registry, calls } = makeRegistry();

  // Never called startTyping — defensive stop should not dispatch anything.
  registry.stopTyping('ch1');

  assert.equal(calls.length, 0, 'no typing notifications should be sent when no interval exists');
});

test('stopTyping(channelId) dispatches stop when an interval was active', () => {
  const { registry, calls } = makeRegistry();

  registry.startTyping('ch1', { topic: 't1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, undefined); // initial start — op defaults
  calls.length = 0;

  registry.stopTyping('ch1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'stop');
  assert.deepEqual(calls[0].metadata, { topic: 't1' });

  // Second stop on the same channel is a no-op — interval already cleared.
  registry.stopTyping('ch1');
  assert.equal(calls.length, 1, 'repeated stopTyping should not re-dispatch');
});

test('startTyping with changed metadata mid-typing dispatches immediate refresh', () => {
  const { registry, calls } = makeRegistry();

  registry.startTyping('ch1', { topic: 'old-topic' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].metadata, { topic: 'old-topic' });
  calls.length = 0;

  // Newer incoming message moves the relevant Zulip topic — caller bumps
  // startTyping with new routing metadata. Should dispatch immediately rather
  // than waiting up to 7s for the next tick.
  registry.startTyping('ch1', { topic: 'new-topic' });
  assert.equal(calls.length, 1, 'metadata change should trigger immediate notification');
  assert.deepEqual(calls[0].metadata, { topic: 'new-topic' });

  registry.stopTyping('ch1');
});

test('startTyping with unchanged metadata mid-typing does not dispatch', () => {
  const { registry, calls } = makeRegistry();

  registry.startTyping('ch1', { topic: 't' });
  calls.length = 0;

  registry.startTyping('ch1', { topic: 't' });
  assert.equal(calls.length, 0, 'no-op when metadata is unchanged');

  registry.stopTyping('ch1');
});

test('startTyping with no metadata mid-typing does not dispatch', () => {
  const { registry, calls } = makeRegistry();

  registry.startTyping('ch1', { topic: 't' });
  calls.length = 0;

  registry.startTyping('ch1');
  assert.equal(calls.length, 0, 'omitted metadata should not trigger a refresh');

  registry.stopTyping('ch1');
});

test('stopTyping() global branch only dispatches stops for channels with intervals', () => {
  const { registry, calls } = makeRegistry();

  // Stash metadata without an interval — simulates a past start that missed
  // findChannelEntry (pre-registration race).
  (registry as unknown as { typingMetadata: Map<string, Record<string, unknown>> }).typingMetadata.set(
    'phantom-ch',
    { foo: 1 },
  );

  registry.startTyping('ch1', { topic: 't' });
  calls.length = 0;

  registry.stopTyping();

  // Exactly one stop for ch1; phantom-ch never had an interval.
  const stops = calls.filter((c) => c.op === 'stop');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].channelId, 'ch1');
});
