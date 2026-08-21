'use strict';

/*
 * Database layer. Node's built-in node:sqlite, so there are zero native
 * dependencies and no compile step on the arm64 target.
 *
 * Everything above this file goes through src/repo.js, never through `db`
 * directly, so swapping to better-sqlite3 later is a one file change.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const DB_PATH = path.join(DATA_DIR, 'third-angle.db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

/*
 * WAL for concurrent reads during a write.
 * cache_size is negative to mean kibibytes, so this is 64 MB. It genuinely
 * improves response times on a 2 OCPU box, and it is also the honest form of
 * the Oracle idle-reclamation memory floor described in DESIGN.md.
 */
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA cache_size = -64000;');
db.exec('PRAGMA mmap_size = 268435456;');

/* ---- startup assertions -------------------------------------------------
 * Each of these has a documented way of failing silently, which is exactly
 * why they are asserted rather than assumed.
 */
function assertEnvironment() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 24) {
    throw new Error(
      `Node 24 or newer required, found ${process.versions.node}. ` +
      'Older builds of node:sqlite ship without FTS5.'
    );
  }

  // Do not trust the default. A silently disabled foreign_keys pragma turns
  // every ON DELETE CASCADE into a no-op.
  const fk = db.prepare('PRAGMA foreign_keys').get();
  if (!fk || Number(Object.values(fk)[0]) !== 1) {
    throw new Error('PRAGMA foreign_keys did not come back on.');
  }

  // FTS5 and the trigram tokenizer are both required. Several Node 22 and 23
  // builds ship without FTS5, and trigram needs SQLite 3.34 or newer.
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(a)");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _trgm_probe USING fts5(a, tokenize='trigram')");
    db.exec('DROP TABLE IF EXISTS _fts_probe');
    db.exec('DROP TABLE IF EXISTS _trgm_probe');
  } catch (err) {
    throw new Error(`SQLite is missing FTS5 or the trigram tokenizer: ${err.message}`);
  }
}

function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
}

/* ---- thin query helpers -------------------------------------------------
 * better-sqlite3 shaped, so the swap seam stays cheap.
 */
const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);
const exec = (sql) => db.exec(sql);

function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const out = fn(...args);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  };
}

const nowIso = () => new Date().toISOString();

module.exports = {
  db, get, all, run, exec, transaction,
  migrate, assertEnvironment, nowIso,
  DATA_DIR, DB_PATH, UPLOAD_DIR,
};
