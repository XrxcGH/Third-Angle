#!/usr/bin/env bash
#
# Nightly logical snapshot.
#
# Litestream already replicates continuously, so why this as well: Litestream
# faithfully replicates a mistake. A bad migration or an accidental DELETE
# reaches the replica in about a second. This snapshot is the layer that
# survives an error, rather than a machine failure.
#
# Installed as /usr/local/bin/third-angle-backup, run by a systemd timer.
#
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/third-angle}"
DATA_DIR="${DATA_DIR:-/srv/third-angle/data}"
DB="$DATA_DIR/third-angle.db"
BACKUP_DIR="$DATA_DIR/backups"
KEEP_DAILY=14
KEEP_MONTHLY=6
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/third-angle-$STAMP.db"

# Optional. If set, a missing ping is what alerts, which is the whole point:
# a backup that fails silently is worse than no backup, because it is trusted.
HEALTHCHECK_URL="${BACKUP_HEALTHCHECK_URL:-}"

fail() {
  echo "backup failed: $*" >&2
  [ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 --data-raw "$*" "$HEALTHCHECK_URL/fail" >/dev/null || true
  exit 1
}

mkdir -p "$BACKUP_DIR"
[ -f "$DB" ] || fail "no database at $DB"

# VACUUM INTO, not the backup API: a consistent, defragmented copy that behaves
# better under concurrent writes. A BARE vacuum would invalidate Litestream's
# page tracking, but VACUUM INTO never touches the source file.
#
# Through the app's own Node and its own SQLite build, so a snapshot cannot
# pass a check here using a different SQLite than the one serving the site.
node "$APP_DIR/scripts/db-tool.mjs" snapshot "$DB" "$OUT" || fail "snapshot failed"

# Prove the copy is readable and complete before trusting it. A snapshot nobody
# opened is a file, not a backup.
node "$APP_DIR/scripts/db-tool.mjs" verify "$OUT" || fail "snapshot failed verification"

gzip -9 -f "$OUT"
OUT="$OUT.gz"
SIZE="$(stat -c %s "$OUT")"

# Size delta guard. A snapshot that suddenly collapses usually means the
# database was truncated or the wrong file was copied, and it would otherwise
# replicate happily over the good one.
PREV="$(find "$BACKUP_DIR" -name 'third-angle-*.db.gz' -not -wholename "$OUT" -printf '%T@ %p\n' \
        | sort -rn | head -1 | cut -d' ' -f2- || true)"
if [ -n "$PREV" ] && [ -f "$PREV" ]; then
  PREV_SIZE="$(stat -c %s "$PREV")"
  MIN=$(( PREV_SIZE * 70 / 100 ))
  [ "$SIZE" -ge "$MIN" ] || fail "snapshot is $SIZE bytes, previous was $PREV_SIZE, more than 30 percent smaller"
fi

# Off box. Cloudflare R2 is the primary, Backblaze B2 the independent second
# provider, because two copies with one vendor is one copy.
if [ -n "${R2_BUCKET:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$OUT" "r2:$R2_BUCKET/snapshots/" --quiet || fail "R2 upload failed"
fi
if [ "$(date -u +%u)" = "7" ] && [ -n "${B2_BUCKET:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$OUT" "b2:$B2_BUCKET/snapshots/" --quiet || fail "B2 upload failed"
fi

# Retention: 14 dailies, plus the first of each month kept for six months.
find "$BACKUP_DIR" -name 'third-angle-*.db.gz' -mtime "+$KEEP_DAILY" \
     -not -name 'third-angle-????????01T*' -delete
find "$BACKUP_DIR" -name 'third-angle-????????01T*.db.gz' -mtime "+$(( KEEP_MONTHLY * 31 ))" -delete

echo "ok $OUT ${SIZE} bytes"
[ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null || true
