import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UsageTracker } from '../src/usage/usage-tracker.js';
import type { UsageUpdatedEvent } from '../src/usage/types.js';

describe('UsageTracker', () => {
  function createTracker() {
    const traces: UsageUpdatedEvent[] = [];
    const tracker = new UsageTracker({ emitTrace: (e) => traces.push(e) });
    return { tracker, traces };
  }

  it('accumulates tokens across multiple inferences', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 });
    tracker.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75, cacheCreationTokens: 10, cacheReadTokens: 30 });

    const snap = tracker.getSnapshot();
    assert.equal(snap.totals.inputTokens, 300);
    assert.equal(snap.totals.outputTokens, 125);
    assert.equal(snap.totals.cacheCreationTokens, 10);
    assert.equal(snap.totals.cacheReadTokens, 30);
    assert.equal(snap.inferenceCount, 2);
  });

  it('tracks per-agent breakdown', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('alice', { inputTokens: 100, outputTokens: 50 });
    tracker.onInferenceCompleted('bob', { inputTokens: 200, outputTokens: 75 });
    tracker.onInferenceCompleted('alice', { inputTokens: 150, outputTokens: 60 });

    const snap = tracker.getSnapshot();
    assert.equal(snap.byAgent.length, 2);

    const alice = snap.byAgent.find(a => a.agentName === 'alice')!;
    assert.equal(alice.usage.inputTokens, 250);
    assert.equal(alice.inferenceCount, 2);

    const bob = snap.byAgent.find(a => a.agentName === 'bob')!;
    assert.equal(bob.usage.inputTokens, 200);
    assert.equal(bob.inferenceCount, 1);
  });

  it('accumulates estimated cost', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' });
    tracker.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' });

    const snap = tracker.getSnapshot();
    assert.ok(snap.totals.estimatedCost);
    assert.ok(Math.abs(snap.totals.estimatedCost.total - 0.03) < 1e-10);
    assert.equal(snap.totals.estimatedCost.currency, 'USD');
  });

  it('drops cost on currency mismatch', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' });
    tracker.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'EUR' });

    const snap = tracker.getSnapshot();
    assert.equal(snap.totals.estimatedCost, undefined);
  });

  it('leaves estimatedCost undefined when no cost data provided', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 });

    const snap = tracker.getSnapshot();
    assert.equal(snap.totals.estimatedCost, undefined);
  });

  it('returns deep-copied snapshots', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' });

    const snap1 = tracker.getSnapshot();
    tracker.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' });

    // snap1 should not have been mutated
    assert.equal(snap1.totals.inputTokens, 100);
    assert.ok(snap1.totals.estimatedCost);
    assert.ok(Math.abs(snap1.totals.estimatedCost.total - 0.01) < 1e-10);
    assert.equal(snap1.inferenceCount, 1);
  });

  it('emits deep-copied trace events', () => {
    const { tracker, traces } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' });
    tracker.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' });

    // First trace should not have been mutated by the second inference
    assert.equal(traces[0].totals.inputTokens, 100);
    assert.ok(traces[0].totals.estimatedCost);
    assert.ok(Math.abs(traces[0].totals.estimatedCost.total - 0.01) < 1e-10);
  });

  it('emits usage:updated trace on each inference', () => {
    const { tracker, traces } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 });

    assert.equal(traces.length, 1);
    assert.equal(traces[0].type, 'usage:updated');
    assert.equal(traces[0].agentName, 'agent');
    assert.equal(traces[0].inferenceCount, 1);
  });

  it('round-trips through toJSON/restore', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('alice', { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 5, cacheReadTokens: 20 }, { total: 0.01, currency: 'USD' });
    tracker.onInferenceCompleted('bob', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' });
    tracker.onInferenceCompleted('alice', { inputTokens: 150, outputTokens: 60 }, { total: 0.015, currency: 'USD' });

    const persisted = tracker.toJSON();
    // Simulate JSON round-trip (as Chronicle does)
    const restored = new UsageTracker({
      emitTrace: () => {},
      restored: JSON.parse(JSON.stringify(persisted)),
    });

    const snap = restored.getSnapshot();
    assert.equal(snap.totals.inputTokens, 450);
    assert.equal(snap.totals.outputTokens, 185);
    assert.equal(snap.totals.cacheCreationTokens, 5);
    assert.equal(snap.totals.cacheReadTokens, 20);
    assert.equal(snap.inferenceCount, 3);
    assert.ok(snap.totals.estimatedCost);
    assert.ok(Math.abs(snap.totals.estimatedCost.total - 0.045) < 1e-10);
    assert.equal(snap.totals.estimatedCost.currency, 'USD');

    assert.equal(snap.byAgent.length, 2);
    const alice = snap.byAgent.find(a => a.agentName === 'alice')!;
    assert.equal(alice.usage.inputTokens, 250);
    assert.equal(alice.inferenceCount, 2);

    const bob = snap.byAgent.find(a => a.agentName === 'bob')!;
    assert.equal(bob.usage.inputTokens, 200);
    assert.equal(bob.inferenceCount, 1);
  });

  it('continues accumulating after restore', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' });

    const restored = new UsageTracker({
      emitTrace: () => {},
      restored: JSON.parse(JSON.stringify(tracker.toJSON())),
    });
    restored.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' });

    const snap = restored.getSnapshot();
    assert.equal(snap.totals.inputTokens, 300);
    assert.equal(snap.totals.outputTokens, 125);
    assert.equal(snap.inferenceCount, 2);
    assert.ok(snap.totals.estimatedCost);
    assert.ok(Math.abs(snap.totals.estimatedCost.total - 0.03) < 1e-10);
  });
});
