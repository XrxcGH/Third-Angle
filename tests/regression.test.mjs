/*
 * Regression tests. Every case here is a bug that was real, reproduced, and
 * fixed during the build. They exist so it cannot come back quietly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCookies } = require('../src/middleware.js');
const repo = require('../src/repo.js');
const db = require('../src/db.js');

test('a malformed cookie does not throw, so it cannot 500 every page', () => {
  // decodeURIComponent throws on a lone '%'. Cookies are attacker controlled
  // and shared across every app on a host, so an unguarded decode took the
  // whole site down for anyone carrying a junk cookie.
  for (const header of [
    'theme=100%',
    'x=%E0%A4%A',
    'a=%%%; b=; =x',
    'theme=dark; broken=%zz',
    '%=%',
    'a='.repeat(500),
  ]) {
    assert.doesNotThrow(() => parseCookies(header), `threw on ${header}`);
  }
  // And a well formed one still decodes.
  assert.equal(parseCookies('theme=dark').theme, 'dark');
  assert.equal(parseCookies('n=a%20b').n, 'a b');
  // A malformed value falls back to the raw text rather than vanishing.
  assert.equal(parseCookies('n=100%').n, '100%');
});

test('reordering the full set in reverse does not collide the unique index', () => {
  // sort_key carries a UNIQUE index and rows update one at a time, so a single
  // pass collides the moment a new key equals a not-yet-updated row's key.
  // Reversing the order is the case that triggers it every time.
  const ids = db.all('SELECT id FROM project ORDER BY sort_key').map((r) => r.id);
  if (ids.length < 2) return; // nothing to prove on an empty database

  const reversed = [...ids].reverse();
  assert.doesNotThrow(() => repo.reorderProjects(reversed));

  const after = db.all('SELECT id FROM project ORDER BY sort_key').map((r) => r.id);
  assert.deepEqual(after, reversed, 'order did not actually change');

  // Restore, and prove the round trip is stable.
  repo.reorderProjects(ids);
  assert.deepEqual(db.all('SELECT id FROM project ORDER BY sort_key').map((r) => r.id), ids);
});

test('no parking keys survive a reorder', () => {
  // The two phase update parks rows at '~<id>'. If any of those are still in
  // the table, phase two did not complete and the order is meaningless.
  const ids = db.all('SELECT id FROM project ORDER BY sort_key').map((r) => r.id);
  if (!ids.length) return;
  repo.reorderProjects([...ids].reverse());
  const parked = db.all("SELECT id, sort_key FROM project WHERE sort_key LIKE '~%'");
  assert.equal(parked.length, 0, `left parked keys: ${JSON.stringify(parked)}`);
  repo.reorderProjects(ids);
});

test('sort keys stay unique and correctly ordered after a reorder', () => {
  const rows = db.all('SELECT id, sort_key FROM project ORDER BY sort_key');
  const keys = rows.map((r) => r.sort_key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate sort keys');
  // Byte-wise ascending. Deliberately not localeCompare: these are case
  // sensitive base62 and a locale aware sort reorders them silently.
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted, 'sort_key ordering is not byte-wise ascending');
});

test('reindexAll is idempotent, so disciplines do not multiply', () => {
  // The upsert probe used `ref_id = ?`, and discipline rows carry a NULL
  // ref_id. `ref_id = NULL` evaluates to NULL, never true, so every reindex
  // appended a fresh copy of all eight disciplines.
  const count = () => db.get('SELECT COUNT(*) AS n FROM search_index').n;
  repo.reindexAll();
  const first = count();
  repo.reindexAll();
  repo.reindexAll();
  assert.equal(count(), first, 'reindexAll is appending duplicates');
});

test('reindexAll sweeps rows whose project no longer exists', () => {
  // search_index deliberately has no foreign key, because it also indexes
  // disciplines and static pages, so orphans must be swept explicitly.
  db.run(
    `INSERT INTO search_index (kind, ref_id, url, title, subtitle, body, tags, published)
     VALUES ('project', 999999, '/work/ghost', 'Ghost', '', '', '', 1)`
  );
  assert.ok(db.get("SELECT id FROM search_index WHERE ref_id = 999999"), 'setup failed');
  repo.reindexAll();
  assert.equal(
    db.get("SELECT id FROM search_index WHERE ref_id = 999999"),
    undefined,
    'orphaned search row survived a reindex'
  );
});

test('indexed text carries no markup, because excerpts render unescaped', () => {
  // The search template must use <%- to render the <mark> highlight, so
  // anything the indexer stores is effectively unescaped output.
  assert.equal(repo.plain('<p>Hello <b>there</b></p>'), 'Hello there');
  assert.ok(!repo.plain('<script>alert(1)</script>').includes('<'));
  assert.ok(!repo.plain('a < b and c > d').includes('<'));
  for (const row of db.all('SELECT title, subtitle, body FROM search_index')) {
    for (const field of ['title', 'subtitle', 'body']) {
      assert.ok(
        !/[<>]/.test(row[field] || ''),
        `search_index.${field} contains angle brackets: ${String(row[field]).slice(0, 80)}`
      );
    }
  }
});
