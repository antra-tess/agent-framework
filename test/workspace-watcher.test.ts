import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MountWatcher, type FsChange } from '../src/modules/workspace/watcher.js';
import type { MountConfig } from '../src/modules/workspace/types.js';

// Short debounce keeps each test under ~200ms.
const DEBOUNCE_MS = 50;
// Chokidar's awaitWriteFinish (stabilityThreshold:100) + our debounce means
// each emission takes ~150ms to land; wait at least 300ms.
const SETTLE_MS = 350;

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mw-test-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeConfig(): MountConfig {
  return {
    name: 'test',
    path: tmp,
    mode: 'read-write',
    watch: 'always',
    watchDebounceMs: DEBOUNCE_MS,
  };
}

function collect(): { watcher: MountWatcher; batches: FsChange[][] } {
  const batches: FsChange[][] = [];
  const watcher = new MountWatcher(makeConfig(), (changes) => {
    batches.push(changes);
  });
  watcher.start();
  return { watcher, batches };
}

async function wait(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

describe('MountWatcher mergeOp', () => {
  it('unlink + add within debounce window → modified (atomic save)', async () => {
    // Seed a file before starting the watcher, so add+unlink+add reduces to
    // unlink+add (atomic save shape).
    const file = join(tmp, 'ticket.md');
    writeFileSync(file, 'v1');

    const { watcher, batches } = collect();
    await wait(100); // let chokidar initialize

    // Atomic save: unlink then write
    unlinkSync(file);
    writeFileSync(file, 'v2');

    await wait(SETTLE_MS);
    await watcher.stop();

    const flat = batches.flat();
    const forFile = flat.filter(c => c.path === 'ticket.md');
    // Expect exactly one batch entry for the file, with op=modified.
    assert.strictEqual(forFile.length, 1, `expected 1 change, got ${JSON.stringify(flat)}`);
    assert.strictEqual(forFile[0].op, 'modified');
  });

  it('create + modify within window → created (net new)', async () => {
    const { watcher, batches } = collect();
    await wait(100);

    const file = join(tmp, 'new.md');
    writeFileSync(file, 'hello');
    // awaitWriteFinish coalesces rapid writes, so spacing the second write
    // slightly increases the chance chokidar surfaces both add and change.
    await wait(10);
    writeFileSync(file, 'hello updated');

    await wait(SETTLE_MS);
    await watcher.stop();

    const forFile = batches.flat().filter(c => c.path === 'new.md');
    assert.strictEqual(forFile.length, 1);
    assert.strictEqual(forFile[0].op, 'created');
  });

  it('delete + create of a pre-existing file → modified (covers atomic-save shape without relying on chokidar add/unlink coalesce timing)', async () => {
    // Seed so the watcher's first observation is the unlink of a real file.
    const file = join(tmp, 'a.md');
    writeFileSync(file, 'v1');

    const { watcher, batches } = collect();
    await wait(100);

    // Double-flip: unlink + recreate + unlink + recreate inside one window.
    unlinkSync(file);
    writeFileSync(file, 'v2');

    await wait(SETTLE_MS);
    await watcher.stop();

    const forFile = batches.flat().filter(c => c.path === 'a.md');
    assert.strictEqual(forFile.length, 1);
    assert.strictEqual(forFile[0].op, 'modified');
  });
});
