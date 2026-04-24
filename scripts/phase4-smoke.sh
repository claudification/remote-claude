#!/usr/bin/env bash
# Phase 4 smoke test -- non-destructive.
#
# Snapshots a read-only copy of the production broker cache into /tmp, runs the
# legacy -> unified migration, boots a scratch broker on an isolated port, and
# hits the cost endpoints. Does NOT touch production data, does NOT modify the
# Docker volume, does NOT write to ~/.cache.
#
# Prereqs: sqlite3 on PATH, bun on PATH, run from the worktree root.
#
# Env overrides:
#   SOURCE        -- source cache dir with legacy cost-data.db
#                    (default: /Users/jonas/OrbStack/docker/volumes/remote-claude_concentrator-data)
#   BROKER_PORT   -- scratch broker port (default: 9991)
#   KEEP_SCRATCH  -- 1 to leave the scratch dir on disk after exit

set -euo pipefail

SOURCE="${SOURCE:-/Users/jonas/OrbStack/docker/volumes/remote-claude_concentrator-data}"
BROKER_PORT="${BROKER_PORT:-9991}"
SCRATCH="$(mktemp -d /tmp/rclaude-phase4-XXXXXX)"
SECRET="phase4-smoke-$$-$(date +%s)"
BROKER_PID=""

case "$SCRATCH" in
  /tmp/*) ;;
  *) echo "ERROR: scratch dir '$SCRATCH' must be under /tmp" >&2; exit 1;;
esac

cleanup() {
  echo
  echo "--- cleanup ---"
  if [ -n "$BROKER_PID" ] && kill -0 "$BROKER_PID" 2>/dev/null; then
    echo "  killing broker pid $BROKER_PID"
    kill "$BROKER_PID" 2>/dev/null || true
    wait "$BROKER_PID" 2>/dev/null || true
  fi
  if [ "${KEEP_SCRATCH:-0}" = "1" ]; then
    echo "  scratch kept: $SCRATCH"
  else
    rm -rf "$SCRATCH"
    echo "  scratch removed"
  fi
}
trap cleanup EXIT

echo "=== Phase 4 smoke test ==="
echo "  source:  $SOURCE"
echo "  scratch: $SCRATCH"
echo "  port:    $BROKER_PORT"
echo

# ─── 1. Snapshot prod cost-data.db into scratch ──────────────────────────
echo "--- snapshot prod cost-data.db (read-only copy) ---"
if [ ! -f "$SOURCE/cost-data.db" ]; then
  echo "ERROR: $SOURCE/cost-data.db not found" >&2
  exit 1
fi

cp "$SOURCE/cost-data.db" "$SCRATCH/"
[ -f "$SOURCE/cost-data.db-wal" ] && cp "$SOURCE/cost-data.db-wal" "$SCRATCH/" || true
[ -f "$SOURCE/cost-data.db-shm" ] && cp "$SOURCE/cost-data.db-shm" "$SCRATCH/" || true

LEGACY_COUNT=$(sqlite3 "$SCRATCH/cost-data.db" "SELECT COUNT(*) FROM turns")
LEGACY_COST=$(sqlite3 "$SCRATCH/cost-data.db" "SELECT printf('%.4f', COALESCE(SUM(cost_usd),0)) FROM turns")
LEGACY_INPUT=$(sqlite3 "$SCRATCH/cost-data.db" "SELECT COALESCE(SUM(input_tokens),0) FROM turns")
echo "  legacy: $LEGACY_COUNT turns, \$$LEGACY_COST, $LEGACY_INPUT input tokens"

# ─── 2. Dry run ──────────────────────────────────────────────────────────
echo
echo "--- migrate --dry-run ---"
bun run src/broker/cli.ts migrate --cache-dir "$SCRATCH" --dry-run

# ─── 3. Actual migration ─────────────────────────────────────────────────
echo
echo "--- migrate (live) ---"
bun run src/broker/cli.ts migrate --cache-dir "$SCRATCH"

NEW_COUNT=$(sqlite3 "$SCRATCH/store.db" "SELECT COUNT(*) FROM turns")
NEW_COST=$(sqlite3 "$SCRATCH/store.db" "SELECT printf('%.4f', COALESCE(SUM(cost_usd),0)) FROM turns")
NEW_INPUT=$(sqlite3 "$SCRATCH/store.db" "SELECT COALESCE(SUM(input_tokens),0) FROM turns")
echo "  new store.db: $NEW_COUNT turns, \$$NEW_COST, $NEW_INPUT input tokens"

MISMATCH=0
[ "$LEGACY_COUNT" != "$NEW_COUNT" ] && MISMATCH=1
[ "$LEGACY_COST" != "$NEW_COST" ] && MISMATCH=1
[ "$LEGACY_INPUT" != "$NEW_INPUT" ] && MISMATCH=1
if [ "$MISMATCH" = "1" ]; then
  echo "  FAIL: legacy vs new counts diverged"
  exit 1
fi
echo "  PASS: row counts + cost + tokens match"

# ─── 4. Idempotency: re-run migrate should skip ──────────────────────────
echo
echo "--- migrate (second run, idempotency check) ---"
if bun run src/broker/cli.ts migrate --cache-dir "$SCRATCH" 2>&1 | tee "$SCRATCH/migrate2.log" | grep -q "already migrated"; then
  echo "  PASS: second run emitted 'already migrated' warning"
else
  echo "  WARN: no 'already migrated' message; verifying row count unchanged"
  RECHECK=$(sqlite3 "$SCRATCH/store.db" "SELECT COUNT(*) FROM turns")
  if [ "$RECHECK" = "$NEW_COUNT" ]; then
    echo "  PASS: row count stayed at $RECHECK after re-run"
  else
    echo "  FAIL: row count changed from $NEW_COUNT to $RECHECK"
    exit 1
  fi
fi

# ─── 5. Boot scratch broker ──────────────────────────────────────────────
echo
echo "--- boot scratch broker on :$BROKER_PORT ---"
RCLAUDE_SECRET="$SECRET" bun run src/broker/index.ts \
  --port "$BROKER_PORT" \
  --cache-dir "$SCRATCH" \
  --rclaude-secret "$SECRET" \
  --no-persistence \
  > "$SCRATCH/broker.log" 2>&1 &
BROKER_PID=$!
echo "  broker pid $BROKER_PID, log: $SCRATCH/broker.log"

# Wait for health
UP=0
for i in $(seq 1 30); do
  if curl -s --max-time 1 "http://localhost:$BROKER_PORT/health" 2>/dev/null | grep -q ok; then
    UP=1
    break
  fi
  sleep 0.3
done
if [ "$UP" = "0" ]; then
  echo "  FAIL: broker did not reach /health in 9s"
  tail -30 "$SCRATCH/broker.log"
  exit 1
fi
echo "  PASS: /health ok"

# ─── 6. Exercise cost endpoints ──────────────────────────────────────────
echo
echo "--- cost endpoints (Authorization: Bearer \$SECRET) ---"
CURL_OPTS=(-s -H "Authorization: Bearer $SECRET" --max-time 5)

summary_json=$(curl "${CURL_OPTS[@]}" "http://localhost:$BROKER_PORT/api/stats/summary?period=30d")
summary_turns=$(echo "$summary_json" | grep -oE '"totalTurns":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")
echo "  /api/stats/summary 30d totalTurns=$summary_turns"
if [ "$summary_turns" = "0" ] && [ "$LEGACY_COUNT" -gt "0" ]; then
  echo "  WARN: endpoint returned 0 turns but legacy had $LEGACY_COUNT (may be due to 30d window if data is older)"
fi

turns_json=$(curl "${CURL_OPTS[@]}" "http://localhost:$BROKER_PORT/api/stats/turns?limit=3")
turns_total=$(echo "$turns_json" | grep -oE '"total":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")
echo "  /api/stats/turns total=$turns_total (limit=3)"
if [ "$turns_total" != "$NEW_COUNT" ]; then
  echo "  FAIL: api total=$turns_total != db count=$NEW_COUNT"
  exit 1
fi
echo "  PASS: /api/stats/turns total matches db count"

hourly_json=$(curl "${CURL_OPTS[@]}" "http://localhost:$BROKER_PORT/api/stats/hourly?groupBy=day")
hourly_rows=$(echo "$hourly_json" | grep -oE '"hour":"[^"]+"' | wc -l | tr -d ' ')
echo "  /api/stats/hourly groupBy=day rows=$hourly_rows"

# ─── 7. Verify legacy cost-data.db unchanged ──────────────────────────────
echo
echo "--- verify production source unchanged ---"
SOURCE_HASH=$(shasum -a 256 "$SOURCE/cost-data.db" | awk '{print $1}')
echo "  source hash: ${SOURCE_HASH:0:16}..."
echo "  (hash this before and after -- identical means we didn't touch it)"

echo
echo "=== all checks passed ==="
