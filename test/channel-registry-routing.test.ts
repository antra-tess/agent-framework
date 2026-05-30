import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

type RouteFailure = { conversationId: string; channelId: string | null; reason: string; textLen: number };

/**
 * Build a registry with a mock server whose publish result is configurable,
 * plus capture arrays for route-failure notifications and emitted traces.
 */
function makeRegistry(publishResult: { delivered?: boolean } | undefined) {
  const failures: RouteFailure[] = [];
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const publishCalls: unknown[] = [];

  const mockServer = {
    sendChannelsPublish: async (params: unknown) => {
      publishCalls.push(params);
      return publishResult;
    },
  };
  const serverRegistry = {
    getServer: (_id: string) => mockServer,
  } as unknown as McplServerRegistry;

  const registry = new ChannelRegistry(
    serverRegistry,
    {} as FeatureSetManager,
    () => {},
    (e) => { traces.push(e); },
    {
      onRouteFailure: (info) => { failures.push(info); },
    },
  );

  // findChannelEntry is private; reach it the same way the typing test reaches
  // the channels map — a test-only cast, not part of the public surface.
  const lookup = (channelId: string) =>
    (registry as unknown as {
      findChannelEntry(id: string): { serverId: string; descriptor: { id: string; label: string; metadata?: Record<string, unknown> } } | undefined;
    }).findChannelEntry(channelId);

  return { registry, failures, traces, publishCalls, lookup };
}

function incoming(channelId: string, text: string, channelName?: string) {
  return {
    messages: [{
      channelId,
      messageId: 'm1',
      author: { id: 'u1', name: 'Antra' },
      timestamp: '2026-05-30T00:00:00.000Z',
      content: [{ type: 'text' as const, text }],
      metadata: channelName ? { channelName } : undefined,
    }],
  };
}

test('handleIncoming lazy-registers an unknown channel so it becomes a publishable locus', async () => {
  const { registry, traces, lookup } = makeRegistry({ delivered: true });

  // Channel "post-boot-ch" was never registered via channels/register|changed.
  assert.equal(lookup('post-boot-ch'), undefined);

  registry.handleIncoming('discord', incoming('post-boot-ch', 'hi', '#cairn'));

  const entry = lookup('post-boot-ch');
  assert.ok(entry, 'channel should be lazy-registered from the inbound message');
  assert.equal(entry!.serverId, 'discord');
  assert.equal(entry!.descriptor.label, '#cairn');
  assert.equal((entry!.descriptor.metadata as { lazyRegistered?: boolean })?.lazyRegistered, true);
  assert.ok(traces.some(t => t.type === 'mcpl:channel-lazy-registered'));

  // routeSpeech now resolves the locus and publishes (no failure).
  const res = await registry.routeSpeech('cairn', 'my reply');
  assert.deepEqual(res, { delivered: true, channelId: 'post-boot-ch' });
});

test('routeSpeech surfaces a failure when the server reports delivered:false', async () => {
  const { registry, failures, traces } = makeRegistry({ delivered: false });
  registry.handleIncoming('discord', incoming('ch-x', 'hi'));

  const res = await registry.routeSpeech('cairn', 'undeliverable reply');

  assert.equal(res, null, 'a non-delivered send must not report success');
  assert.equal(failures.length, 1, 'onRouteFailure should fire');
  assert.equal(failures[0].channelId, 'ch-x');
  assert.match(failures[0].reason, /delivered:false/);
  assert.ok(traces.some(t => t.type === 'mcpl:speech-route-failed'));
});

test('routeSpeech surfaces a failure when there is no locus at all', async () => {
  const { registry, failures } = makeRegistry({ delivered: true });
  // No handleIncoming → defaultPublishChannel is null.
  const res = await registry.routeSpeech('cairn', 'into the void');
  assert.equal(res, null);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].channelId, null);
  assert.match(failures[0].reason, /no locus/);
});
