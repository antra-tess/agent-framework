import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo } from '../src/gate/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate');

function tmpPath(name: string): string {
  return join(TMP_DIR, name);
}

function writeConfig(name: string, config: GateConfig): string {
  const path = tmpPath(name);
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

interface TraceEntry {
  type: string;
  [key: string]: unknown;
}

function makeGate(configPath: string, opts?: { initialConfig?: GateConfig }) {
  const traces: TraceEntry[] = [];
  const messages: Array<{ participant: string; content: unknown; metadata?: unknown }> = [];
  const inferenceRequests: Array<{ agentName: string; reason: string; source: string }> = [];

  const gate = new EventGate({
    configPath,
    initialConfig: opts?.initialConfig,
    emitTrace: (e) => traces.push(e as TraceEntry),
    addMessage: (p, c, m) => { messages.push({ participant: p, content: c, metadata: m }); return ''; },
    requestInference: (a, r, s) => inferenceRequests.push({ agentName: a, reason: r, source: s }),
    getAgentNames: () => ['agent'],
  });

  return { gate, traces, messages, inferenceRequests };
}

function event(overrides?: Partial<GateEventInfo>): GateEventInfo {
  return {
    content: 'test message',
    eventType: 'mcpl:push-event',
    serverId: '',
    channelId: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Default behavior (no config file)
// ---------------------------------------------------------------------------

describe('default behavior', () => {
  it('no config file + no initial config → all-pass', () => {
    const { gate } = makeGate(tmpPath('nonexistent.json'));
    const decision = gate.evaluate(event());
    assert.strictEqual(decision.trigger, true);
    assert.strictEqual(decision.policyName, null);
  });

  it('default: skip → all skipped', () => {
    const path = writeConfig('skip-default.json', {
      policies: [],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    const decision = gate.evaluate(event());
    assert.strictEqual(decision.trigger, false);
  });
});

// ---------------------------------------------------------------------------
// Policy matching
// ---------------------------------------------------------------------------

describe('policy matching', () => {
  it('scope match — matching event type', () => {
    const path = writeConfig('scope.json', {
      policies: [
        { name: 'channels', match: { scope: ['mcpl:channel-incoming'] }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ eventType: 'mcpl:channel-incoming' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ eventType: 'mcpl:push-event' })).trigger, false);
  });

  it('source match — exact serverId', () => {
    const path = writeConfig('source.json', {
      policies: [
        { name: 'zulip', match: { source: 'zulip' }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ serverId: 'zulip' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ serverId: 'discord' })).trigger, false);
  });

  it('source match — glob pattern', () => {
    const path = writeConfig('source-glob.json', {
      policies: [
        { name: 'any-zulip', match: { source: 'zulip-*' }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ serverId: 'zulip-prod' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ serverId: 'zulip-staging' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ serverId: 'discord' })).trigger, false);
  });

  it('channel match — glob pattern', () => {
    const path = writeConfig('channel-glob.json', {
      policies: [
        { name: 'dev-channels', match: { channel: 'dev-*' }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ channelId: 'dev-backend' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ channelId: 'prod-alerts' })).trigger, false);
  });

  it('mount match — exact name', () => {
    const path = writeConfig('mount-exact.json', {
      policies: [
        {
          name: 'tickets',
          match: { scope: ['workspace:created'], mount: 'knowledge-requests' },
          behavior: 'always',
        },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:created', mount: 'knowledge-requests', paths: ['knowledge-requests/t1.md'] })).trigger,
      true,
    );
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:created', mount: 'library-mined', paths: ['library-mined/r1.md'] })).trigger,
      false,
    );
    // Event without a mount must not match a mount-scoped policy.
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:created' })).trigger,
      false,
    );
  });

  it('pathGlob match — any path matches', () => {
    const path = writeConfig('path-glob.json', {
      policies: [
        {
          name: 'md-only',
          match: { scope: ['workspace:modified'], pathGlob: '*.md' },
          behavior: 'always',
        },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:modified', paths: ['tickets/a.md'] })).trigger,
      true,
    );
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:modified', paths: ['logs/a.txt'] })).trigger,
      false,
    );
    // ANY-match: one matching path is enough.
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:modified', paths: ['logs/a.txt', 'tickets/b.md'] })).trigger,
      true,
    );
    // Empty paths can't match a pathGlob policy.
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:modified', paths: [] })).trigger,
      false,
    );
  });

  it('content filter — text match (case insensitive)', () => {
    const path = writeConfig('filter-text.json', {
      policies: [
        { name: 'errors', match: { filter: { type: 'text', pattern: 'ERROR' } }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ content: 'Something error happened' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ content: 'All good' })).trigger, false);
  });

  it('content filter — regex match', () => {
    const path = writeConfig('filter-regex.json', {
      policies: [
        { name: 'deploys', match: { filter: { type: 'regex', pattern: 'deploy|rollback' } }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ content: 'Starting deploy v2.3' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ content: 'rollback initiated' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ content: 'Rolling back' })).trigger, false);
  });

  it('combined match — scope + source + filter (AND logic)', () => {
    const path = writeConfig('combined.json', {
      policies: [
        {
          name: 'zulip-errors',
          match: {
            scope: ['mcpl:channel-incoming'],
            source: 'zulip',
            filter: { type: 'text', pattern: 'error' },
          },
          behavior: 'always',
        },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    // All conditions met
    assert.strictEqual(gate.evaluate(event({
      content: 'An error occurred',
      eventType: 'mcpl:channel-incoming',
      serverId: 'zulip',
    })).trigger, true);
    // Wrong scope
    assert.strictEqual(gate.evaluate(event({
      content: 'An error occurred',
      eventType: 'mcpl:push-event',
      serverId: 'zulip',
    })).trigger, false);
    // Wrong source
    assert.strictEqual(gate.evaluate(event({
      content: 'An error occurred',
      eventType: 'mcpl:channel-incoming',
      serverId: 'discord',
    })).trigger, false);
    // No error keyword
    assert.strictEqual(gate.evaluate(event({
      content: 'All good',
      eventType: 'mcpl:channel-incoming',
      serverId: 'zulip',
    })).trigger, false);
  });

  it('first match wins — order matters', () => {
    const path = writeConfig('order.json', {
      policies: [
        { name: 'suppress-noise', match: { filter: { type: 'text', pattern: 'heartbeat' } }, behavior: 'skip' },
        { name: 'catch-all', match: {}, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ content: 'heartbeat ping' })).trigger, false);
    assert.strictEqual(gate.evaluate(event({ content: 'real message' })).trigger, true);
  });

  it('empty match object matches everything', () => {
    const path = writeConfig('empty-match.json', {
      policies: [
        { name: 'catch-all', match: {}, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ serverId: 'any', channelId: 'any' })).trigger, true);
  });
});

// ---------------------------------------------------------------------------
// Behaviors
// ---------------------------------------------------------------------------

describe('behaviors', () => {
  it('always → trigger: true', () => {
    const path = writeConfig('always.json', {
      policies: [{ name: 'all', match: {}, behavior: 'always' }],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    const d = gate.evaluate(event());
    assert.strictEqual(d.trigger, true);
    assert.strictEqual(d.behavior, 'always');
  });

  it('skip → trigger: false', () => {
    const path = writeConfig('skip.json', {
      policies: [{ name: 'quiet', match: {}, behavior: 'skip' }],
      default: 'always',
    });
    const { gate } = makeGate(path);
    const d = gate.evaluate(event());
    assert.strictEqual(d.trigger, false);
    assert.strictEqual(d.behavior, 'skip');
    assert.strictEqual(d.policyName, 'quiet');
  });
});

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe('debounce', () => {
  it('returns false immediately', () => {
    const path = writeConfig('debounce.json', {
      policies: [
        { name: 'editor', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    const d = gate.evaluate(event());
    assert.strictEqual(d.trigger, false);
    assert.deepStrictEqual(d.behavior, { debounce: 100 });
  });

  it('batches events and fires after delay', async () => {
    const path = writeConfig('debounce-fire.json', {
      policies: [
        { name: 'editor', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 150 } },
      ],
      default: 'skip',
    });
    const { gate, messages, inferenceRequests } = makeGate(path);

    gate.evaluate(event({ content: 'edit 1' }));
    gate.evaluate(event({ content: 'edit 2' }));
    gate.evaluate(event({ content: 'edit 3' }));

    // Should not have delivered yet
    assert.strictEqual(messages.length, 0);

    // Wait for debounce to fire
    await new Promise(r => setTimeout(r, 200));

    assert.strictEqual(messages.length, 1);
    const text = (messages[0].content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes('3 event'));
    assert.ok(text.includes('[editor]'));
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].agentName, 'agent');
  });

  it('resets timer on new events', async () => {
    const path = writeConfig('debounce-reset.json', {
      policies: [
        { name: 'editor', match: {}, behavior: { debounce: 150 } },
      ],
      default: 'skip',
    });
    const { gate, messages } = makeGate(path);

    gate.evaluate(event({ content: 'edit 1' }));
    await new Promise(r => setTimeout(r, 80));
    // Timer hasn't fired yet, send another
    gate.evaluate(event({ content: 'edit 2' }));
    await new Promise(r => setTimeout(r, 80));
    // Still within debounce window of second event
    assert.strictEqual(messages.length, 0);

    await new Promise(r => setTimeout(r, 100));
    // Now it should have fired
    assert.strictEqual(messages.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Debounce bounds validation
// ---------------------------------------------------------------------------

describe('debounce bounds', () => {
  it('rejects debounce < 100ms', () => {
    const path = tmpPath('low-debounce.json');
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({
      policies: [{ name: 'fast', match: {}, behavior: { debounce: 50 } }],
      default: 'always',
    }));
    const { gate, traces } = makeGate(path);
    // Should fall back to default config, emit error trace
    assert.strictEqual(gate.evaluate(event()).trigger, true);
    assert.ok(traces.some(t => t.type === 'gate:config-error'));
  });

  it('rejects debounce > 300000ms', () => {
    const path = tmpPath('high-debounce.json');
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({
      policies: [{ name: 'slow', match: {}, behavior: { debounce: 500000 } }],
      default: 'always',
    }));
    const { gate, traces } = makeGate(path);
    assert.strictEqual(gate.evaluate(event()).trigger, true);
    assert.ok(traces.some(t => t.type === 'gate:config-error'));
  });
});

// ---------------------------------------------------------------------------
// Inference buffering
// ---------------------------------------------------------------------------

describe('inference buffering', () => {
  it('inference buffer is capped at MAX_INFERENCE_BUFFER', async () => {
    const path = writeConfig('infer-cap.json', {
      policies: [
        { name: 'chat', match: {}, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, messages } = makeGate(path);
    gate.onInferenceStarted('agent');

    // Fire many debounce batches — each with 20 events, 6 batches = 120 events
    for (let batch = 0; batch < 6; batch++) {
      for (let i = 0; i < 20; i++) {
        gate.evaluate(event({ content: `batch${batch}-msg${i}` }));
      }
      // Let debounce fire (into inference buffer since inferring)
      await new Promise(r => setTimeout(r, 150));
    }

    // Buffer should be capped at 100 (oldest dropped)
    const bufferLen = (gate as any).inferenceBuffer.length;
    assert.ok(bufferLen <= 100, `Expected buffer <= 100, got ${bufferLen}`);
    assert.ok(bufferLen > 0, 'Expected buffer to have events');

    // First event should NOT be from batch 0 (those were dropped)
    const firstEvent = (gate as any).inferenceBuffer[0];
    assert.ok(!firstEvent.content.startsWith('batch0'), `Expected oldest events dropped, but first is ${firstEvent.content}`);

    // End inference → flush
    gate.onInferenceEnded('agent');
    await new Promise(r => setTimeout(r, 10));

    assert.strictEqual(messages.length, 1);
    gate.dispose();
  });

  it('debounce during inference → buffer → flush on end', async () => {
    const path = writeConfig('infer-debounce.json', {
      policies: [
        { name: 'chat', match: {}, behavior: { debounce: 150 } },
      ],
      default: 'skip',
    });
    const { gate, messages } = makeGate(path);

    gate.evaluate(event({ content: 'msg 1' }));
    gate.evaluate(event({ content: 'msg 2' }));

    // Simulate inference started before debounce fires
    gate.onInferenceStarted('agent');

    // Wait for debounce timer to fire
    await new Promise(r => setTimeout(r, 200));

    // Should be buffered, not delivered (inference is active)
    assert.strictEqual(messages.length, 0);

    // End inference → flush
    gate.onInferenceEnded('agent');

    // queueMicrotask defers delivery
    await new Promise(r => setTimeout(r, 10));

    assert.strictEqual(messages.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Config hot-reload
// ---------------------------------------------------------------------------

describe('config hot-reload', () => {
  it('reloads config when file changes', async () => {
    const path = writeConfig('reload.json', {
      policies: [{ name: 'all', match: {}, behavior: 'always' }],
      default: 'skip',
    });
    const { gate } = makeGate(path);

    assert.strictEqual(gate.evaluate(event()).trigger, true);

    // Force throttle to expire
    (gate as any).lastReloadCheck = 0;

    // Wait for mtime to differ
    await new Promise(r => setTimeout(r, 50));

    // Rewrite config — now skip everything
    writeFileSync(path, JSON.stringify({ policies: [], default: 'skip' }));

    assert.strictEqual(gate.evaluate(event()).trigger, false);
  });

  it('config error keeps previous valid config', async () => {
    const path = writeConfig('error-reload.json', {
      policies: [{ name: 'all', match: {}, behavior: 'always' }],
      default: 'skip',
    });
    const { gate, traces } = makeGate(path);
    assert.strictEqual(gate.evaluate(event()).trigger, true);

    // Force throttle to expire
    (gate as any).lastReloadCheck = 0;
    await new Promise(r => setTimeout(r, 50));

    // Write invalid JSON
    writeFileSync(path, 'not valid json{{{');

    // Should still use previous config
    assert.strictEqual(gate.evaluate(event()).trigger, true);
    assert.ok(traces.some(t => t.type === 'gate:config-error'));
  });
});

// ---------------------------------------------------------------------------
// Config seeding
// ---------------------------------------------------------------------------

describe('config seeding', () => {
  it('seeds config file from initialConfig when file does not exist', () => {
    const path = tmpPath('seeded.json');
    const config: GateConfig = {
      policies: [{ name: 'test', match: {}, behavior: 'always' }],
      default: 'skip',
    };
    makeGate(path, { initialConfig: config });

    assert.ok(existsSync(path));
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    assert.strictEqual(written.policies[0].name, 'test');
  });

  it('does not overwrite existing file', () => {
    const path = writeConfig('existing.json', {
      policies: [{ name: 'original', match: {}, behavior: 'always' }],
      default: 'always',
    });

    makeGate(path, {
      initialConfig: {
        policies: [{ name: 'new', match: {}, behavior: 'skip' }],
        default: 'skip',
      },
    });

    const written = JSON.parse(readFileSync(path, 'utf-8'));
    assert.strictEqual(written.policies[0].name, 'original');
  });
});

// ---------------------------------------------------------------------------
// gate:status tool
// ---------------------------------------------------------------------------

describe('gate:status tool', () => {
  it('returns correct status structure', async () => {
    const path = writeConfig('status.json', {
      policies: [
        { name: 'always-policy', match: {}, behavior: 'always' },
        { name: 'debounce-policy', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 1000 } },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);

    // Trigger some matches
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming' }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming' }));

    const result = await gate.handleToolCall();
    assert.strictEqual(result.success, true);
    const status = result.data!;
    assert.strictEqual(status.configPath, path);
    assert.strictEqual(status.configSource, 'file');
    assert.strictEqual(status.default, 'skip');
    assert.strictEqual(status.policies.length, 2);
    assert.strictEqual(status.policies[0].name, 'always-policy');
    assert.strictEqual(status.policies[0].matchCount, 2);
    assert.strictEqual(status.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// asShouldTriggerCallback
// ---------------------------------------------------------------------------

describe('asShouldTriggerCallback', () => {
  it('returns a function with the shouldTriggerInference signature', () => {
    const path = writeConfig('callback.json', {
      policies: [
        { name: 'allow-zulip', match: { source: 'zulip' }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    const cb = gate.asShouldTriggerCallback();

    assert.strictEqual(typeof cb, 'function');
    assert.strictEqual(cb('hello', { eventType: 'mcpl:push-event', serverId: 'zulip' }), true);
    assert.strictEqual(cb('hello', { eventType: 'mcpl:push-event', serverId: 'discord' }), false);
  });
});

// ---------------------------------------------------------------------------
// Trace events
// ---------------------------------------------------------------------------

describe('trace events', () => {
  it('emits gate:policy-matched on match', () => {
    const path = writeConfig('trace-match.json', {
      policies: [{ name: 'test', match: {}, behavior: 'always' }],
      default: 'skip',
    });
    const { gate, traces } = makeGate(path);
    gate.evaluate(event());

    const matchTraces = traces.filter(t => t.type === 'gate:policy-matched');
    assert.strictEqual(matchTraces.length, 1);
    assert.strictEqual(matchTraces[0].policyName, 'test');
  });

  it('emits gate:config-reloaded on successful reload', async () => {
    const path = writeConfig('trace-reload.json', {
      policies: [],
      default: 'always',
    });
    const { gate, traces } = makeGate(path);
    gate.evaluate(event()); // initial eval

    (gate as any).lastReloadCheck = 0;
    await new Promise(r => setTimeout(r, 50));
    writeFileSync(path, JSON.stringify({ policies: [{ name: 'new', match: {}, behavior: 'skip' }], default: 'always' }));

    gate.evaluate(event());

    assert.ok(traces.some(t => t.type === 'gate:config-reloaded'));
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe('dispose', () => {
  it('clears debounce timers without delivering', () => {
    const path = writeConfig('dispose.json', {
      policies: [{ name: 'debounced', match: {}, behavior: { debounce: 10000 } }],
      default: 'skip',
    });
    const { gate, messages } = makeGate(path);
    gate.evaluate(event());
    gate.dispose();

    // No delivery should happen
    assert.strictEqual(messages.length, 0);
  });
});
