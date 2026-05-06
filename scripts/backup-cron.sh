#!/usr/bin/env bash
# Hourly backup cron for the broker container.
#
# Runs inside the host (not inside Docker). Executes broker-cli backup
# inside the running container, with tiered retention:
#   - All backups from the last 24 hours (hourly granularity)
#   - 1 per day for the last 7 days (daily granularity)
#
# Install:
#   crontab -e
#   0 * * * * /path/to/scripts/backup-cron.sh >> /var/log/broker-backup.log 2>&1
#
# Override container name via BROKER_CONTAINER env var (default: broker).

set -euo pipefail

CONTAINER="${BROKER_CONTAINER:-broker}"
DEST="/data/backups"
RETAIN_HOURS=24
RETAIN_DAYS=7

echo "--- $(date -Iseconds) backup start ---"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: container '$CONTAINER' is not running"
  exit 1
fi

docker exec "$CONTAINER" broker-cli backup create \
  --dest "$DEST" \
  --retain-hours "$RETAIN_HOURS" \
  --retain-days "$RETAIN_DAYS"

echo "--- $(date -Iseconds) backup done ---"
