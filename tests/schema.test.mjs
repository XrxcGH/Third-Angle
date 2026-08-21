/*
 * Schema guarantees. Each of these closes a specific risk from DESIGN.md and
 * each has a way of failing silently, which is why it is asserted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../src/db.js');

test('R3: facet labels cannot differ only by case', () => {
  // STRICT does nothing here: 'Electrical' and 'electrical' are both legal
  // TEXT. Only the NOCASE unique index closes it.
  assert.throws(
    () => db.run(
      "INSERT INTO facet (slug, label, kind, sort_key) VALUES ('electrical-2', 'ELECTRICAL', 'discipline', 'zz')"
    ),
    /UNIQUE|constraint/i
  );
});

test('R3: colour tokens are constrained to the vetted palette', () => {
  assert.throws(
    () => db.run(
      "INSERT INTO facet (slug, label, kind, color_token, sort_key) VALUES ('x', 'X', 'discipline', '#ff00ff', 'zz')"
    ),
    /CHECK|constraint/i
  );
});

test('R2: media origin is constrained, so downloaded parts cannot pose as evidence', () => {
  assert.throws(
    () => db.run(
      `INSERT INTO media (kind, storage_key, mime, bytes, origin, created_at)
       VALUES ('photo', 'k1', 'image/jpeg', 1, 'definitely-mine', '2026-01-01')`
    ),
    /CHECK|constraint/i
  );
});

test('R8: project tier is constrained, so the twelve block form cannot be forced', () => {
  assert.throws(
    () => db.run(
      `INSERT INTO project (slug, title, tier, sort_key, created_at, updated_at)
       VALUES ('t1', 'T', 'enormous', 'a0', '2026-01-01', '2026-01-01')`
    ),
    /CHECK|constraint/i
  );
});

test('foreign keys are actually enforced, not merely declared', () => {
  assert.throws(
    () => db.run(
      "INSERT INTO project_facet (project_id, facet_slug, sort_key) VALUES (999999, 'mechanical', 'a0')"
    ),
    /FOREIGN KEY|constraint/i
  );
});

test('sort_key ordering is byte-wise, never case-insensitive', () => {
  // Fractional index keys are case sensitive base62. A NOCASE collation or a
  // localeCompare sort produces a silently wrong order months later.
  const cols = db.all("PRAGMA table_info(project)");
  const sk = cols.find((c) => c.name === 'sort_key');
  assert.ok(sk, 'project.sort_key missing');
  const ddl = db.get("SELECT sql FROM sqlite_master WHERE name = 'project'").sql;
  assert.ok(!/sort_key[^,]*NOCASE/i.test(ddl), 'sort_key must not be COLLATE NOCASE');
});

test('FTS5 and the trigram tokenizer are both present', () => {
  assert.doesNotThrow(() => {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _t1 USING fts5(a)");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _t2 USING fts5(a, tokenize='trigram')");
    db.exec('DROP TABLE IF EXISTS _t1');
    db.exec('DROP TABLE IF EXISTS _t2');
  });
});
