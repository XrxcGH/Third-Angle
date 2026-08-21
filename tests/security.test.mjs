import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { safeBackPath } = require('../src/routes/public.js');

test('safeBackPath allows ordinary in-site paths', () => {
  for (const p of ['/', '/work', '/work?d=electrical', '/disciplines/controls']) {
    assert.equal(safeBackPath(p), p);
  }
});

test('safeBackPath refuses off-site redirects', () => {
  // '//host' and '/\host' are protocol relative and a browser follows them off
  // site. A bare startsWith('/') check lets both through.
  for (const p of [
    '//evil.com', String.raw`/\evil.com`, 'https://evil.com', 'http://evil.com',
    '//evil.com/path', 'javascript:alert(1)', '',
  ]) {
    assert.equal(safeBackPath(p), '/', `expected / for ${JSON.stringify(p)}`);
  }
});

test('safeBackPath refuses traversal, header splitting and junk types', () => {
  assert.equal(safeBackPath('/../etc/passwd'), '/');
  assert.equal(safeBackPath('/work\r\nSet-Cookie: a=b'), '/');
  assert.equal(safeBackPath('/' + 'a'.repeat(600)), '/');
  assert.equal(safeBackPath(undefined), '/');
  assert.equal(safeBackPath(null), '/');
  assert.equal(safeBackPath(42), '/');
  assert.equal(safeBackPath({}), '/');
});
