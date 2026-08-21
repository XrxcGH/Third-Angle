/*
 * Backup and restore verification.
 *
 * These matter more than they look. Litestream's failure mode gives no signal
 * until you need it, so the only thing standing between a silent backup failure
 * and losing the site is whether these assertions actually fire. A verifier that
 * always passes is worse than none, because it is trusted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOOL = path.join(ROOT, 'scripts', 'db-tool.mjs');
const LIVE = path.join(ROOT, 'data', 'third-angle.db');

const work = mkdtempSync(path.join(tmpdir(), 'ta-backup-'));

/** Returns { code, out }. Never throws, so a failure can be asserted on. */
function tool(...args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout || '') + (err.stderr || '') };
  }
}

const snap = path.join(work, 'snap.db');

test('snapshot produces a verifiable copy of the live database', () => {
  const res = tool('snapshot', LIVE, snap);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /^snapshot /);

  const ok = tool('verify', snap);
  assert.equal(ok.code, 0, `a fresh snapshot must verify: ${ok.out}`);
  assert.match(ok.out, /projects/);
});

test('snapshot refuses to overwrite, so a rerun cannot destroy last night', () => {
  const res = tool('snapshot', LIVE, snap);
  assert.equal(res.code, 1);
  assert.match(res.out, /refusing to overwrite/);
});

test('verify rejects an empty database that is otherwise perfectly valid', () => {
  // This is the case a naive check misses: schema intact, integrity fine,
  // zero content. It would restore cleanly and serve an empty site.
  const empty = path.join(work, 'empty.db');
  const db = new DatabaseSync(empty);
  db.exec(readFileSync(path.join(ROOT, 'src', 'schema.sql'), 'utf8'));
  db.close();

  const res = tool('verify', empty);
  assert.equal(res.code, 1, 'an empty database was accepted');
  assert.match(res.out, /zero projects/);
});

test('verify rejects a stale restore, which passes every structural check', () => {
  const stale = path.join(work, 'stale.db');
  copyFileSync(snap, stale);
  const db = new DatabaseSync(stale);
  db.exec("UPDATE project SET updated_at = '2024-01-01T00:00:00.000Z'");
  db.close();

  const res = tool('verify', stale);
  assert.equal(res.code, 1, 'a stale restore was accepted');
  assert.match(res.out, /days old/);
});

test('verify catches an FTS5 index that has drifted from its content table', () => {
  // External-content FTS5 can desynchronise silently, and search then returns
  // wrong results rather than erroring. The rank 1 argument is what makes the
  // integrity-check able to see it.
  const desync = path.join(work, 'desync.db');
  copyFileSync(snap, desync);
  const db = new DatabaseSync(desync);
  db.exec('DROP TRIGGER search_index_ad');
  db.exec('DELETE FROM search_index WHERE id = (SELECT MIN(id) FROM search_index)');
  db.close();

  const res = tool('verify', desync);
  assert.equal(res.code, 1, 'a desynchronised search index was accepted');
  assert.match(res.out, /FTS5|corrupt|out of sync/i);
});

test('verify catches a corrupt file', () => {
  const corrupt = path.join(work, 'corrupt.db');
  const buf = readFileSync(snap);
  buf.fill(0, 30_000, 60_000);
  writeFileSync(corrupt, buf);

  const res = tool('verify', corrupt);
  assert.equal(res.code, 1, 'a corrupt database was accepted');
  assert.match(res.out, /integrity_check|malformed/i);
});

test('verify exits non-zero on a missing file rather than reporting success', () => {
  const res = tool('verify', path.join(work, 'does-not-exist.db'));
  assert.equal(res.code, 1);
  assert.match(res.out, /no such database/);
});

test('the deploy scripts are syntactically valid shell', () => {
  // A backup script with a syntax error fails at 03:17 on a night nobody is
  // watching, and the only symptom is a missing heartbeat.
  const { execFileSync: run } = { execFileSync };
  for (const s of ['provision.sh', 'backup.sh', 'restore-verify.sh', 'alive.sh']) {
    const p = path.join(ROOT, 'deploy', s);
    try {
      run('bash', ['-n', p], { stdio: 'pipe' });
    } catch (err) {
      if (err.code === 'ENOENT') return; // no bash on this machine, skip
      assert.fail(`${s} has a shell syntax error: ${err.stderr}`);
    }
  }
});

test('the deploy scripts do not depend on the sqlite3 CLI', () => {
  // Node is guaranteed present because it runs the app, and using the app's own
  // SQLite build means a check cannot pass here while the app fails.
  for (const s of ['backup.sh', 'restore-verify.sh']) {
    const text = readFileSync(path.join(ROOT, 'deploy', s), 'utf8');
    assert.ok(!/^\s*sqlite3\s/m.test(text), `${s} still shells out to sqlite3`);
  }
});

test('litestream config pins above the silently broken releases', () => {
  // 0.5.6 and 0.5.7 fail replication completely with no error output.
  const prov = readFileSync(path.join(ROOT, 'deploy', 'provision.sh'), 'utf8');
  const m = /LITESTREAM_VERSION=([0-9.]+)/.exec(prov);
  assert.ok(m, 'no pinned Litestream version in provision.sh');
  const [maj, min, patch] = m[1].split('.').map(Number);
  assert.ok(maj > 0 || min > 5 || patch > 7, `Litestream ${m[1]} is at or below the broken 0.5.7`);
});

process.on('exit', () => {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('shell scripts are stored with LF endings, not CRLF', () => {
  // A script checked out with CRLF fails on Linux with
  // "bad interpreter: /usr/bin/env bash^M", which is a confusing error to
  // meet at 1am during a restore. .gitattributes pins this; the test proves it.
  for (const s of ['provision.sh', 'backup.sh', 'restore-verify.sh', 'alive.sh']) {
    const text = readFileSync(path.join(ROOT, 'deploy', s), 'utf8');
    assert.ok(!text.includes('\r\n'), `deploy/${s} contains CRLF line endings`);
    assert.ok(text.startsWith('#!'), `deploy/${s} lost its shebang`);
  }
});
