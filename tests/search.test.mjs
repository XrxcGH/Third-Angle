/*
 * Search regression tests.
 *
 * Every case here is a bug that was actually present during the build, or a
 * documented footgun that would break the page silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repo = require('../src/repo.js');
const db = require('../src/db.js');

test('hostile input never reaches FTS5 as syntax', () => {
  // FTS5 has its own query language. A stray quote, colon, or caret produces a
  // syntax error and a 500 on the one page a recruiter is most likely to use.
  for (const q of ['"', 'a:b', 'x^2', 'NEAR(', 'a OR b', '"unclosed', '*', 'C++', "o'brien", '\u005C']) {
    assert.doesNotThrow(() => repo.search(q), `threw on ${JSON.stringify(q)}`);
  }
});

test('a single letter does not prefix-match the whole corpus', () => {
  // "C++" tokenises to "c", and "c"* matched every row in the table.
  const r = repo.search('C++');
  const total = db.get('SELECT COUNT(*) AS n FROM search_index').n;
  assert.ok(r.results.length < total, `"C++" returned ${r.results.length} of ${total} rows`);
});

test('prefix matching works, which proves the tokenizer is not porter', () => {
  // A porter-stemmed index silently returns zero for 'harn*' even though it
  // contains "harnesses". If someone switches the tokenizer, this fails.
  assert.ok(repo.search('harn').results.length > 0, 'prefix query found nothing');
  assert.ok(repo.search('swerve').results.length > 0);
});

test('the trigram stage recovers a substring the prefix stage cannot', () => {
  const r = repo.search('lectric');
  assert.ok(r.results.length > 0, 'substring query found nothing');
  assert.equal(r.fallback && r.fallback.kind, 'near');
});

test('the edit-distance stage recovers a typo', () => {
  for (const [typo, want] of [['elctrical', 'electrical'], ['swrve', 'swerve'], ['documentaton', 'documentation']]) {
    const r = repo.search(typo);
    assert.ok(r.results.length > 0, `${typo} found nothing`);
    assert.equal(r.fallback && r.fallback.kind, 'corrected');
    assert.ok(r.fallback.term.includes(want), `${typo} corrected to ${r.fallback.term}, expected ${want}`);
  }
});

test('nonsense returns nothing rather than everything', () => {
  assert.equal(repo.search('zzzzqqqwww').results.length, 0);
  assert.equal(repo.search('').results.length, 0);
  assert.equal(repo.search(null).results.length, 0);
  assert.equal(repo.search('   ').results.length, 0);
});

test('unpublished rows never appear in results', () => {
  const before = repo.search('swerve').results.length;
  db.run("UPDATE search_index SET published = 0 WHERE kind = 'project'");
  const after = repo.search('swerve').results.length;
  db.run("UPDATE search_index SET published = 1 WHERE kind = 'project'");
  assert.ok(after < before, 'unpublished projects still returned');
});
