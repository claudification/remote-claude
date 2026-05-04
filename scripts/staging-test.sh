#!/usr/bin/env bash
# Usage: scripts/staging-test.sh [--keep]
#   --keep: don't tear down after tests (for debugging)
#
# Builds everything from the current branch, starts a staging broker
# in Docker, runs wire protocol tests against the live broker, then
# tears everything down.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

# 1. Generate a random test secret
STAGING_SECRET=$(openssl rand -hex 32)
STAGING_PORT=19999

echo "[staging] Secret: ${STAGING_SECRET:0:8}..."
echo "[staging] Port: $STAGING_PORT"

# 2. Build web + broker
echo "[staging] Building web assets..."
bun run build:web

echo "[staging] Building Docker image..."
docker compose -f docker-compose.staging.yml build

# 3. Start staging broker
echo "[staging] Starting broker on :$STAGING_PORT..."
RCLAUDE_SECRET="$STAGING_SECRET" PORT="$STAGING_PORT" \
  docker compose -f docker-compose.staging.yml up -d

# 4. Wait for health
echo "[staging] Waiting for broker health..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$STAGING_PORT/health" > /dev/null 2>&1; then
    echo "[staging] Broker healthy!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[staging] FAILED: Broker didn't start within 30s"
    echo "[staging] Container logs:"
    docker compose -f docker-compose.staging.yml logs --tail=50
    docker compose -f docker-compose.staging.yml down -v
    exit 1
  fi
  sleep 1
done

# 5. Run staging tests
echo "[staging] Running tests..."
TEST_EXIT=0
STAGING_BROKER_URL="localhost:$STAGING_PORT" STAGING_SECRET="$STAGING_SECRET" \
  bunx vitest run src/broker/__tests__/staging/ 2>&1 || TEST_EXIT=$?

# 6. Tear down (unless --keep)
if [[ "${1:-}" != "--keep" ]]; then
  echo "[staging] Tearing down..."
  docker compose -f docker-compose.staging.yml down -v
else
  echo "[staging] --keep: broker still running on :$STAGING_PORT"
  echo "[staging] Secret: $STAGING_SECRET"
  echo "[staging] Tear down manually: docker compose -f docker-compose.staging.yml down -v"
fi

# 7. Report
echo ""
if [ "$TEST_EXIT" -eq 0 ]; then
  echo "[staging] ALL TESTS PASSED"
else
  echo "[staging] TESTS FAILED (exit $TEST_EXIT)"
  exit "$TEST_EXIT"
fi
