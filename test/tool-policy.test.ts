import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isToolAllowed } from '../src/mcpl/tool-policy.js';

describe('isToolAllowed', () => {
  it('allows everything when no policy is set', () => {
    assert.strictEqual(isToolAllowed('upload_file', undefined), true);
    assert.strictEqual(isToolAllowed('upload_file', {}), true);
  });

  it('allow-list: only listed tools pass', () => {
    const policy = { enabledTools: ['list_files', 'read_file'] };
    assert.strictEqual(isToolAllowed('list_files', policy), true);
    assert.strictEqual(isToolAllowed('read_file', policy), true);
    assert.strictEqual(isToolAllowed('upload_file', policy), false);
  });

  it('deny-list: listed tools blocked, rest allowed', () => {
    const policy = { disabledTools: ['delete_file', 'rename'] };
    assert.strictEqual(isToolAllowed('delete_file', policy), false);
    assert.strictEqual(isToolAllowed('rename', policy), false);
    assert.strictEqual(isToolAllowed('read_file', policy), true);
  });

  it('deny wins over allow on overlap', () => {
    const policy = { enabledTools: ['*'], disabledTools: ['upload_*'] };
    assert.strictEqual(isToolAllowed('upload_file', policy), false);
    assert.strictEqual(isToolAllowed('read_file', policy), true);
  });

  it('wildcards: prefix, suffix, and bare *', () => {
    assert.strictEqual(isToolAllowed('read_file', { enabledTools: ['read_*'] }), true);
    assert.strictEqual(isToolAllowed('write_file', { enabledTools: ['read_*'] }), false);
    assert.strictEqual(isToolAllowed('read_file', { enabledTools: ['*_file'] }), true);
    assert.strictEqual(isToolAllowed('read_dir', { enabledTools: ['*_file'] }), false);
    assert.strictEqual(isToolAllowed('anything_at_all', { enabledTools: ['*'] }), true);
  });

  it('literal patterns require exact match (not substring)', () => {
    const policy = { enabledTools: ['read'] };
    assert.strictEqual(isToolAllowed('read', policy), true);
    assert.strictEqual(isToolAllowed('read_file', policy), false);
  });

  it('regex metacharacters in patterns are treated literally', () => {
    const policy = { enabledTools: ['get.file', 'foo+bar', 'baz(qux)'] };
    assert.strictEqual(isToolAllowed('get.file', policy), true);
    assert.strictEqual(isToolAllowed('getXfile', policy), false, '. is not a regex wildcard');
    assert.strictEqual(isToolAllowed('foo+bar', policy), true);
    assert.strictEqual(isToolAllowed('foobar', policy), false, '+ is not a regex quantifier');
    assert.strictEqual(isToolAllowed('baz(qux)', policy), true);
  });

  it('empty arrays behave like absent fields', () => {
    assert.strictEqual(isToolAllowed('anything', { enabledTools: [] }), true);
    assert.strictEqual(isToolAllowed('anything', { disabledTools: [] }), true);
  });
});
