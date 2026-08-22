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

/*
 * Columns added to a table that already exists.
 *
 * schema.sql is written with CREATE TABLE IF NOT EXISTS, which is idempotent
 * for new tables and a no-op for a table that is already there. A column added
 * to an existing table therefore never appears on a database created by an
 * earlier version, and the failure is a runtime "no such column" on whichever
 * page happens to read it first.
 *
 * Kept as an explicit, ordered list rather than a migrations directory: this is
 * a single-writer SQLite file with one operator, and a folder of numbered files
 * would be more machinery than the problem has.
 */
const ADDED_COLUMNS = [
  // A photo belongs to at most one album. The collage pages render an album,
  // so setting this IS publishing the photo.
  ['media', 'album_slug', 'TEXT REFERENCES album(slug) ON DELETE SET NULL'],
  // Pins the resume and the CV to the top of the document library. Everything
  // else is 'other' and sorts below by its fractional index.
  ['document', 'doc_role', "TEXT NOT NULL DEFAULT 'other'"],
  // Delivery state for a contact message. The message is stored first and
  // mailed second, so a mail failure can never lose the message; this column is
  // what turns that from a silent loss into a visible retry.
  ['message', 'mail_status', "TEXT NOT NULL DEFAULT 'pending'"],
  ['message', 'mail_error', 'TEXT'],
  ['message', 'mailed_at', 'TEXT'],
];

function addMissingColumns() {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all()
      .some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  addMissingColumns();
  // Indexes over added columns have to come after the columns exist.
  db.exec('CREATE INDEX IF NOT EXISTS media_album ON media(album_slug)');
  db.exec('CREATE INDEX IF NOT EXISTS document_role ON document(doc_role, sort_key)');
  db.exec('CREATE INDEX IF NOT EXISTS message_mail_status ON message(mail_status, created_at DESC)');

  /*
   * The personal wall is one wall. Any albums left over from when it was a set
   * of them are folded into it, keeping every photograph. Idempotent, and a
   * no-op once there is nothing to fold. Required here rather than at the top
   * of the file because repo.js requires this module.
   */
  try {
    require('./repo').ensurePersonalWall();
  } catch { /* a database this old has no album table yet; schema.sql just made it */ }
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
  migrate, addMissingColumns, assertEnvironment, nowIso,
  DATA_DIR, DB_PATH, UPLOAD_DIR,
};
