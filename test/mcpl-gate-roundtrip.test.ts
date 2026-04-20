import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { EventGate } from '../src/gate/event-gate.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { GateConfig } from '../src/gate/types.js';
import type { ChannelsIncomingParams } from '../src/mcpl/types.js';
import type { ProcessEvent } from '../src/types/index.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-roundtrip');

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

function makeGate(config: GateConfig) {
  const configPath = join(TMP_DIR, 'gate.json');
  writeFileSync(configPath, JSON.stringify(config));
  return new EventGate({
    configPath,
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
  });
}

function makeRegistry(shouldTriggerInference?: (c: string, m: Record<string, unknown>) => boolean) {
  const pushed: ProcessEvent[] = [];
  const registry = new ChannelRegistry(
    {} as never,
    {} as never,
    (ev) => pushed.push(ev),
    () => {},
    shouldTriggerInference ? { shouldTriggerInference } : undefined,
  );
  return { registry, pushed };
}

function incomingParams(channelId: string, text: string): ChannelsIncomingParams {
  return {
    messages: [{
      channelId,
      messageId: 'msg-1',
      author: { id: '42', name: 'Alice' },
      timestamp: new Date().toISOString(),
      content: [{ type: 'text', text }],
    }],
  };
}

// ---------------------------------------------------------------------------
// Contract: ChannelRegistry emits eventType='mcpl:channel-incoming' to the gate
// ---------------------------------------------------------------------------

describe('ChannelRegistry → shouldTriggerInference contract', () => {
  it('emits eventType="mcpl:channel-incoming" in callback metadata', () => {
    const seen: Array<Record<string, unknown>> = [];
    const { registry } = makeRegistry((_content, metadata) => {
      seen.push(metadata);
      return true;
    });

    registry.handleIncoming('zulip', incomingParams('zulip:tracker-miner-f', 'hi'));

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].eventType, 'mcpl:channel-incoming');
    assert.strictEqual(seen[0].serverId, 'zulip');
    assert.strictEqual(seen[0].channelId, 'zulip:tracker-miner-f');
  });
});

// ---------------------------------------------------------------------------
// Roundtrip: a recipe-shaped channel policy fires for a channel-incoming event
// ---------------------------------------------------------------------------

describe('ChannelRegistry + EventGate roundtrip', () => {
  it('channel-scoped policy triggers inference on matching channel-incoming', () => {
    const gate = makeGate({
      default: 'skip',
      policies: [
        {
          name: 'tracker-channel',
          match: { scope: ['mcpl:channel-incoming'], channel: 'zulip:tracker-miner-f' },
          behavior: 'always',
        },
      ],
    });

    const { registry, pushed } = makeRegistry(gate.asShouldTriggerCallback());

    registry.handleIncoming('zulip', incomingParams('zulip:tracker-miner-f', 'question in channel'));

    assert.strictEqual(pushed.length, 1);
    const event = pushed[0] as { type: string; triggerInference?: boolean };
    assert.strictEqual(event.type, 'mcpl:channel-incoming');
    assert.strictEqual(event.triggerInference, true);
  });

  it('default:skip wins when no policy matches the channel', () => {
    const gate = makeGate({
      default: 'skip',
      policies: [
        {
          name: 'tracker-channel',
          match: { scope: ['mcpl:channel-incoming'], channel: 'zulip:tracker-miner-f' },
          behavior: 'always',
        },
      ],
    });

    const { registry, pushed } = makeRegistry(gate.asShouldTriggerCallback());

    registry.handleIncoming('zulip', incomingParams('zulip:other-channel', 'noise'));

    assert.strictEqual(pushed.length, 1);
    const event = pushed[0] as { type: string; triggerInference?: boolean };
    assert.strictEqual(event.triggerInference, false);
  });
});

// ---------------------------------------------------------------------------
// ChannelRegistry: per-server channelSubscription policy gates auto-open
// ---------------------------------------------------------------------------

describe('ChannelRegistry subscriptionPolicy', () => {
  function makeServerStub() {
    const opens: Array<{ type: string; address: unknown }> = [];
    const server = {
      sendChannelsOpen: async (args: { type: string; address: unknown }) => { opens.push(args); },
    };
    const serverRegistry = { getServer: () => server } as unknown as ConstructorParameters<typeof ChannelRegistry>[0];
    return { opens, serverRegistry };
  }

  const channels = [
    { id: 'zulip:tracker-miner-f', type: 'zulip-stream' as const, address: { streamId: 1 }, name: 'tracker-miner-f' },
    { id: 'zulip:general', type: 'zulip-stream' as const, address: { streamId: 2 }, name: 'general' },
    { id: 'zulip:random', type: 'zulip-stream' as const, address: { streamId: 3 }, name: 'random' },
  ];
  const registerParams = { channels } as unknown as ChannelsIncomingParams;

  it("default 'auto' opens every registered channel", async () => {
    const { opens, serverRegistry } = makeServerStub();
    const registry = new ChannelRegistry(serverRegistry, {} as never, () => {}, () => {});

    await registry.handleRegister('zulip', registerParams as never);

    assert.strictEqual(opens.length, 3);
  });

  it("'manual' opens nothing but still registers the channels", async () => {
    const { opens, serverRegistry } = makeServerStub();
    const registry = new ChannelRegistry(serverRegistry, {} as never, () => {}, () => {});
    registry.setSubscriptionPolicy('zulip', 'manual');

    await registry.handleRegister('zulip', registerParams as never);

    assert.strictEqual(opens.length, 0);
    assert.strictEqual(registry.getOpenChannels().length, 0);
  });

  it('string[] allow-list opens only matching channels', async () => {
    const { opens, serverRegistry } = makeServerStub();
    const registry = new ChannelRegistry(serverRegistry, {} as never, () => {}, () => {});
    registry.setSubscriptionPolicy('zulip', ['zulip:tracker-miner-f']);

    await registry.handleRegister('zulip', registerParams as never);

    assert.strictEqual(opens.length, 1);
    assert.deepStrictEqual(opens[0].address, { streamId: 1 });
  });
});
