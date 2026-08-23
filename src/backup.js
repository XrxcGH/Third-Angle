'use strict';

/*
 * Persistence for a machine with no disk.
 *
 * On a VPS this file does nothing: DATA_DIR is a real directory on a real disk
 * and it survives a restart. On Cloudflare Containers it is the whole story.
 * A container's filesystem is ephemeral — it goes back to the image every time
 * the container sleeps, which it does after a few minutes of no traffic — so
 * the SQLite file and every uploaded image would be gone by the second visit.
 *
 * So DATA_DIR is mirrored to an R2 bucket:
 *
 *   restore()   before the database is opened, pull the last snapshot down
 *   snapshot()  on a timer while running, and once more on the way out
 *
 * The direction of truth is always local-to-remote while the process is up.
 * R2 is a backup of the disk, not a second source: exactly one container is
 * ever running (see worker/index.js, which routes every request to one named
 * instance), so there is one writer and no merge to get wrong.
 *
 * Nothing here is required. With no R2 credentials in the environment, every
 * function returns immediately and the app behaves exactly as it does today.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const s3 = require('./s3');

/* Where things live in the bucket. The prefix keeps the bucket reusable. */
const PREFIX = process.env.R2_PREFIX || 'third-angle';
const DB_KEY = `${PREFIX}/db/third-angle.db`;
const UPLOAD_PREFIX = `${PREFIX}/uploads/`;

const INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_SECONDS || 120) * 1000;

let bucket = null;
/*
 * Whether this process is allowed to delete from the bucket.
 *
 * Only after a restore that completed, or one that found nothing to restore.
 * A restore that failed half way leaves the disk holding some of the data, and
 * a snapshot from that state would read the missing files as deletions and
 * remove them from the only copy that still has them.
 */
let authoritative = false;
let remoteUploads = null;   // Set of keys known to be in the bucket
let timer = null;
let lastFingerprint = '';
let running = false;

function configured() {
  if (bucket === null) bucket = s3.fromEnv() || false;
  return bucket || null;
}

/** Every file under data/uploads, as paths relative to it. */
function localUploads(uploadDir) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(uploadDir, '');
  return out;
}

/**
 * Pull the last snapshot down. Must run BEFORE src/db is required, because
 * requiring it opens the database file, and a file replaced underneath an open
 * handle is a corruption that will not show up until a query fails.
 */
async function restore({ dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data') } = {}) {
  const b = configured();
  if (!b) return { skipped: 'no R2 configured' };

  const dbPath = path.join(dataDir, 'third-angle.db');
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  /*
   * A database already on disk wins.
   *
   * This only happens when the container did not actually restart, or on a
   * machine with a real disk that has R2 configured for backups. Overwriting a
   * live file with an older snapshot is the one unrecoverable mistake
   * available here, so it is never done.
   */
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    remoteUploads = new Set((await b.list(UPLOAD_PREFIX)).map((k) => k.slice(UPLOAD_PREFIX.length)));
    authoritative = true;
    return { kept: 'local database is present' };
  }

  const snapshot = await b.get(DB_KEY);
  if (snapshot) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, snapshot);
  }

  const keys = await b.list(UPLOAD_PREFIX);
  remoteUploads = new Set(keys.map((k) => k.slice(UPLOAD_PREFIX.length)));
  let files = 0;
  for (const key of keys) {
    const rel = key.slice(UPLOAD_PREFIX.length);
    if (!rel) continue;
    const dest = path.join(uploadDir, rel);
    /* A key from the bucket must not be able to write outside the directory. */
    if (!dest.startsWith(uploadDir + path.sep)) continue;
    const bytes = await b.get(key);
    if (!bytes) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    files += 1;
  }

  authoritative = true;
  return { database: snapshot ? snapshot.length : 0, files };
}

/**
 * Push the current state up.
 *
 * The database is copied with VACUUM INTO rather than read off the disk: a live
 * SQLite file plus its write-ahead log is not a valid database on its own, and
 * copying one under load produces a snapshot that opens and then fails a query
 * later. VACUUM INTO asks SQLite for a consistent single file, which is the
 * same thing the backup script on the VPS does.
 */
async function snapshot({ force = false } = {}) {
  const b = configured();
  if (!b || !authoritative || running) return { skipped: true };

  const db = require('./db');
  const dataDir = db.DATA_DIR;
  const uploadDir = db.UPLOAD_DIR;

  const files = localUploads(uploadDir);
  const stat = fs.existsSync(db.DB_PATH) ? fs.statSync(db.DB_PATH) : null;
  const fingerprint = `${stat ? stat.size + ':' + stat.mtimeMs : '0'}|${files.length}`;
  if (!force && fingerprint === lastFingerprint) return { unchanged: true };

  running = true;
  const tmp = path.join(os.tmpdir(), `third-angle-${process.pid}-${Date.now()}.db`);
  try {
    db.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    await b.put(DB_KEY, fs.readFileSync(tmp), 'application/vnd.sqlite3');

    if (!remoteUploads) {
      remoteUploads = new Set((await b.list(UPLOAD_PREFIX)).map((k) => k.slice(UPLOAD_PREFIX.length)));
    }

    let pushed = 0;
    for (const rel of files) {
      if (remoteUploads.has(rel)) continue;
      await b.put(UPLOAD_PREFIX + rel, fs.readFileSync(path.join(uploadDir, rel)));
      remoteUploads.add(rel);
      pushed += 1;
    }

    /* Anything the bucket still holds that the disk no longer does was deleted
       through the admin, and the bucket should not keep serving it back on the
       next restore. Safe only because this process restored the disk. */
    let removed = 0;
    const present = new Set(files);
    for (const rel of [...remoteUploads]) {
      if (present.has(rel)) continue;
      await b.delete(UPLOAD_PREFIX + rel);
      remoteUploads.delete(rel);
      removed += 1;
    }

    lastFingerprint = fingerprint;
    return { database: fs.statSync(tmp).size, pushed, removed };
  } finally {
    running = false;
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
  }
}

/**
 * Snapshot on a timer while the process is up.
 *
 * unref, so an idle timer never keeps the process alive: the container is
 * supposed to be able to exit when it has nothing to do.
 */
function schedule() {
  if (!configured() || timer) return null;
  timer = setInterval(() => {
    snapshot().catch((err) => console.error('backup: scheduled snapshot failed:', err.message));
  }, INTERVAL_MS);
  timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** For tests: forget the cached bucket and state. */
function reset() {
  bucket = null; authoritative = false; remoteUploads = null;
  lastFingerprint = ''; stop();
}

module.exports = {
  restore, snapshot, schedule, stop, reset, configured,
  DB_KEY, UPLOAD_PREFIX, localUploads,
};
