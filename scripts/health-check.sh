#!/usr/bin/env bash
# Health check for Synology infrastructure
# Checks Docker, critical containers, and public endpoints
# Sends email on failure via Synology's built-in mail notification
#
# Install as cron on Synology:
#   scp scripts/health-check.sh jonas@synology:/volume1/docker/scripts/
#   ssh synology 'echo "0 * * * * /volume1/docker/scripts/health-check.sh" | sudo tee -a /etc/crontab'
#
# Or via Synology Task Scheduler (DSM UI) - recommended

set -euo pipefail

DOCKER="/volume1/@appstore/ContainerManager/usr/bin/docker"
NOTIFY_EMAIL="j@duplo.org"
LOGFILE="/volume1/docker/scripts/health-check.log"

# Critical containers that MUST be running
CRITICAL_CONTAINERS=(
  caddy-proxy
  broker
)

# Public endpoints to verify (curl from localhost since we're on the NAS)
PUBLIC_ENDPOINTS=(
  "http://172.20.7.133:9999/health|broker"
)

FAILURES=()

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOGFILE" 2>/dev/null || true
}

# 1. Check Docker daemon
if ! "$DOCKER" info >/dev/null 2>&1; then
  FAILURES+=("Docker daemon is NOT running")
  log "FAIL: Docker daemon down"

  # Try to restart
  sudo synopkg start ContainerManager 2>/dev/null
  sleep 30

  if "$DOCKER" info >/dev/null 2>&1; then
    log "RECOVERED: Docker daemon restarted"
    FAILURES+=("(auto-recovered: ContainerManager restarted)")
  else
    log "FAIL: Docker daemon restart failed"
  fi
fi

# 2. Check critical containers
if "$DOCKER" info >/dev/null 2>&1; then
  for container in "${CRITICAL_CONTAINERS[@]}"; do
    status=$("$DOCKER" inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo "not_found")
    if [ "$status" != "running" ]; then
      FAILURES+=("Container $container is $status")
      log "FAIL: $container is $status"

      # Try to start it
      "$DOCKER" start "$container" 2>/dev/null || true
      sleep 5
      new_status=$("$DOCKER" inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo "not_found")
      if [ "$new_status" = "running" ]; then
        log "RECOVERED: $container started"
        FAILURES+=("(auto-recovered: $container started)")
      else
        log "FAIL: $container restart failed (still $new_status)"
      fi
    fi
  done
fi

# 3. Check endpoints
for entry in "${PUBLIC_ENDPOINTS[@]}"; do
  url="${entry%%|*}"
  name="${entry##*|}"
  if ! curl -sf --max-time 10 "$url" >/dev/null 2>&1; then
    FAILURES+=("Endpoint $name ($url) is unreachable")
    log "FAIL: $name endpoint down"
  fi
done

# 4. Report failures
if [ ${#FAILURES[@]} -gt 0 ]; then
  BODY="Health check failures at $(date):\n\n"
  for f in "${FAILURES[@]}"; do
    BODY+="  - $f\n"
  done
  BODY+="\nHost: $(hostname)\n"

  # Send via Synology notification (uses configured SMTP)
  if command -v synodsmnotify >/dev/null 2>&1; then
    sudo synodsmnotify -c @administrators "Health Check Failed" "$(echo -e "$BODY")" 2>/dev/null || true
  fi

  # Also try direct email via sendmail/msmtp if available
  if command -v msmtp >/dev/null 2>&1; then
    echo -e "Subject: [SYNOLOGY] Health Check Failed\nTo: $NOTIFY_EMAIL\n\n$BODY" | msmtp "$NOTIFY_EMAIL" 2>/dev/null || true
  elif [ -x /usr/sbin/sendmail ]; then
    echo -e "Subject: [SYNOLOGY] Health Check Failed\nTo: $NOTIFY_EMAIL\n\n$BODY" | /usr/sbin/sendmail "$NOTIFY_EMAIL" 2>/dev/null || true
  fi

  # Write to stderr for cron to capture
  echo -e "$BODY" >&2
  log "ALERT: Sent notification with ${#FAILURES[@]} failure(s)"
  exit 1
else
  log "OK: All checks passed"
  exit 0
fi
