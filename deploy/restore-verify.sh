#!/usr/bin/env bash
#
# Restore verification. Risk R5, and the one that makes every other backup
# control mean something.
#
# Litestream's failure mode gives no signal until you need it. So this does not
# check that a backup EXISTS, it restores one and interrogates it. An
# unrehearsed backup is a belief.
#
# Runs on the box via a systemd timer rather than in GitHub Actions, because
# scheduled workflows on a public repository are automatically disabled after
# 60 days without repository activity, which is precisely the quiet stretch
# when this matters most.
#
#   third-angle-verify            verify from Litestream, then from a snapshot
#   third-angle-verify snapshot   snapshot only, no network needed
#
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/third-angle}"
DATA_DIR="${DATA_DIR:-/srv/third-angle/data}"
DB="$DATA_DIR/third-angle.db"
BACKUP_DIR="$DATA_DIR/backups"
WORK="$(mktemp -d)"
MODE="${1:-all}"
HEALTHCHECK_URL="${VERIFY_HEALTHCHECK_URL:-}"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

fail() {
  echo "VERIFY FAILED: $*" >&2
  [ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 --data-raw "$*" "$HEALTHCHECK_URL/fail" >/dev/null || true
  exit 1
}

# All five assertions live in scripts/db-tool.mjs, so the checks a restore is
# held to are identical to the ones a snapshot is held to, and they run through
# the same SQLite build the application uses.
interrogate() {
  node "$APP_DIR/scripts/db-tool.mjs" verify "$1" || fail "$2: verification failed"
}

echo "Restore verification, $(date -u +%FT%TZ)"

if [ "$MODE" = "all" ] && [ -f /etc/litestream.yml ]; then
  echo "  Restoring from Litestream replica"
  litestream restore -config /etc/litestream.yml -o "$WORK/from-replica.db" "$DB" \
    || fail "litestream restore failed"
  interrogate "$WORK/from-replica.db" "replica"
fi

LATEST="$(find "$BACKUP_DIR" -name 'third-angle-*.db.gz' -printf '%T@ %p\n' 2>/dev/null \
          | sort -rn | head -1 | cut -d' ' -f2- || true)"
if [ -n "$LATEST" ]; then
  echo "  Restoring from snapshot $(basename "$LATEST")"
  gunzip -c "$LATEST" > "$WORK/from-snapshot.db"
  interrogate "$WORK/from-snapshot.db" "snapshot"
else
  fail "no snapshot found in $BACKUP_DIR"
fi

echo "Both restores verified."
[ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null || true
