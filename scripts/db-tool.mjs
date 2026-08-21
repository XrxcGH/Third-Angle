/*
 * Database operations for the backup and restore scripts.
 *
 * In Node rather than the sqlite3 CLI, for three reasons. Node is guaranteed
 * present because it runs the app, so this removes a package from the
 * provision script. It uses the SAME SQLite build the app uses, so a check
 * here cannot pass while the app fails. And it is testable on a development
 * machine rather than only on the server, which is how the restore drill stops
 * being something that is only ever run for the first time in an emergency.
 *
 *   node scripts/db-tool.mjs snapshot <src.db> <dest.db>
 *   node scripts/db-tool.mjs verify   <file.db> [--max-age-days N]
 *   node scripts/db-tool.mjs stats    <file.db>
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const [, , cmd, file, ...rest] = process.argv;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function open(f, readonly = true) {
  if (!existsSync(f)) die(`no such database: ${f}`);
  return new DatabaseSync(f, { readOnly: readonly });
}

function arg(name, fallback) {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
}

/* -------------------------------------------------------------- snapshot */

if (cmd === 'snapshot') {
  const dest = rest[0];
  if (!file || !dest) die('usage: db-tool.mjs snapshot <src.db> <dest.db>');
  if (existsSync(dest)) die(`refusing to overwrite ${dest}`);

  /*
   * VACUUM INTO, not the backup API. It produces a consistent, defragmented
   * copy and behaves better under concurrent writes. Note that a BARE VACUUM
   * would invalidate Litestream's page tracking; VACUUM INTO never touches the
   * source file, which is why it is safe to run beside a live replicator.
   */
  const db = open(file, false);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  db.close();

  const bytes = statSync(dest).size;
  console.log(`snapshot ${path.basename(dest)} ${bytes}`);
  process.exit(0);
}

/* ---------------------------------------------------------------- verify */

if (cmd === 'verify') {
  if (!file) die('usage: db-tool.mjs verify <file.db> [--max-age-days N]');
  const maxAge = Number(arg('--max-age-days', 45));
  /*
   * Read-WRITE, deliberately. The FTS5 'integrity-check' command is issued as
   * an INSERT into the virtual table's special column, so a read-only handle
   * makes it fail with "attempt to write a readonly database" on a perfectly
   * healthy file. That would turn this check into one that always reports
   * failure, which is only marginally better than one that always passes.
   *
   * Safe because verify only ever runs against a restored COPY, never the live
   * database. The caller is responsible for that, and both callers honour it.
   */
  const db = open(file, false);
  const problems = [];
  const notes = [];

  const one = (sql) => {
    const row = db.prepare(sql).get();
    return row ? Object.values(row)[0] : null;
  };

  // 1. Structural integrity of the file itself.
  try {
    if (one('PRAGMA integrity_check') !== 'ok') problems.push('integrity_check did not return ok');
  } catch (e) { problems.push(`integrity_check threw: ${e.message}`); }

  // 2. Referential integrity. A restore can be structurally fine and still
  //    have lost the rows that other rows point at.
  try {
    const orphans = db.prepare('PRAGMA foreign_key_check').all();
    if (orphans.length) problems.push(`foreign_key_check found ${orphans.length} orphaned rows`);
  } catch (e) { problems.push(`foreign_key_check threw: ${e.message}`); }

  // 3. FTS5 consistency. rank 1 is REQUIRED: the index is external-content, and
  //    without it this cannot detect an index that has drifted from its table.
  try {
    db.exec("INSERT INTO search_fts(search_fts, rank) VALUES('integrity-check', 1)");
  } catch (e) {
    problems.push(`FTS5 index is corrupt or out of sync: ${e.message}`);
  }

  // 4. Content, not just schema. A perfectly restored empty database passes
  //    every check above and is useless.
  try {
    const projects = one('SELECT COUNT(*) FROM project');
    const facets = one("SELECT COUNT(*) FROM facet WHERE kind = 'discipline'");
    const indexed = one('SELECT COUNT(*) FROM search_index');
    if (!projects) problems.push('zero projects, this is not a usable restore');
    if (facets < 8) problems.push(`only ${facets} disciplines, expected at least 8`);
    if (!indexed) problems.push('search index is empty');
    notes.push(`${projects} projects, ${facets} disciplines, ${indexed} indexed rows`);
  } catch (e) { problems.push(`content query failed: ${e.message}`); }

  // 5. Recency. A restore that passes everything else and is three weeks stale
  //    is a different failure, and one that otherwise reports success.
  try {
    const newest = one('SELECT MAX(updated_at) FROM project');
    if (!newest) {
      problems.push('no updated_at timestamps at all');
    } else {
      const days = Math.floor((Date.now() - Date.parse(newest)) / 86_400_000);
      notes.push(`newest record ${days} days old`);
      if (days > maxAge) problems.push(`newest record is ${days} days old, limit ${maxAge}`);
    }
  } catch (e) { problems.push(`recency check failed: ${e.message}`); }

  db.close();

  if (problems.length) {
    console.error(`VERIFY FAILED for ${path.basename(file)}`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`ok ${path.basename(file)}: ${notes.join(', ')}`);
  process.exit(0);
}

/* ----------------------------------------------------------------- stats */

if (cmd === 'stats') {
  if (!file) die('usage: db-tool.mjs stats <file.db>');
  const db = open(file);
  const q = (sql) => { try { return Object.values(db.prepare(sql).get())[0]; } catch { return 'n/a'; } };
  console.log(`file       ${(statSync(file).size / 1024).toFixed(0)} KB`);
  console.log(`sqlite     ${q('SELECT sqlite_version()')}`);
  console.log(`projects   ${q('SELECT COUNT(*) FROM project')}`);
  console.log(`published  ${q('SELECT COUNT(*) FROM project WHERE published = 1')}`);
  console.log(`media      ${q('SELECT COUNT(*) FROM media')}`);
  console.log(`indexed    ${q('SELECT COUNT(*) FROM search_index')}`);
  console.log(`newest     ${q('SELECT MAX(updated_at) FROM project')}`);
  db.close();
  process.exit(0);
}

die('usage: db-tool.mjs <snapshot|verify|stats> <file.db> [...]');
