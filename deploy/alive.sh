#!/usr/bin/env bash
# Litestream liveness. Installed as /usr/local/bin/third-angle-alive.
#
# Asserts the replica WAL index has not gone BACKWARDS since the previous
# scrape, and that the metrics endpoint still answers at all. It deliberately
# does not require the index to advance: nothing is written on a quiet day.
set -euo pipefail

STATE=/var/lib/third-angle/litestream-last
HEALTHCHECK_URL="${LITESTREAM_HEALTHCHECK_URL:-}"
mkdir -p "$(dirname "$STATE")"

fail() {
  echo "litestream liveness failed: $*" >&2
  [ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 --data-raw "$*" "$HEALTHCHECK_URL/fail" >/dev/null || true
  exit 1
}

METRICS="$(curl -fsS -m 5 http://localhost:9090/metrics)" || fail "metrics endpoint unreachable, process is probably dead"

NOW="$(echo "$METRICS" | awk '/^litestream_replica_wal_index/ {sum += $2} END {print sum+0}')"
PREV="$(cat "$STATE" 2>/dev/null || echo -1)"
echo "$NOW" > "$STATE"

# On the very first run there is nothing to compare against.
[ "$PREV" = "-1" ] && { echo "first run, recorded $NOW"; exit 0; }

# The index legitimately does not move when nothing has been written, so the
# check is that it never goes BACKWARDS and that the endpoint still answers.
# A regression means the replica was reset underneath us.
[ "$NOW" -ge "$PREV" ] || fail "replica index went backwards, $PREV to $NOW"

echo "ok, replica index $NOW"
[ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null || true
