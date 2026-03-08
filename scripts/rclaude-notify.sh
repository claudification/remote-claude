#!/bin/bash
# rclaude-notify - Send push notifications from Claude Code sessions
#
# Uses env vars set by rclaude:
#   RCLAUDE_CONCENTRATOR_URL  - HTTP URL of concentrator
#   RCLAUDE_SECRET            - Auth secret
#   RCLAUDE_SESSION_ID        - Current session ID
#
# Usage:
#   rclaude-notify "title" "message body"
#   rclaude-notify "Build complete"              # title only
#   echo "long message" | rclaude-notify "title"  # body from stdin

set -euo pipefail

URL="${RCLAUDE_CONCENTRATOR_URL:-}"
SECRET="${RCLAUDE_SECRET:-}"
SESSION="${RCLAUDE_SESSION_ID:-}"

if [ -z "$URL" ] || [ -z "$SECRET" ]; then
  echo "ERROR: RCLAUDE_CONCENTRATOR_URL and RCLAUDE_SECRET must be set" >&2
  echo "These are set automatically when running inside rclaude" >&2
  exit 1
fi

TITLE="${1:-Notification}"
BODY="${2:-}"

# Read body from stdin if not provided and stdin is not a terminal
if [ -z "$BODY" ] && [ ! -t 0 ]; then
  BODY=$(cat)
fi

# Use printf + escaping to build valid JSON (handles newlines, quotes)
PAYLOAD=$(printf '%s' "{\"title\":$(printf '%s' "$TITLE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),\"body\":$(printf '%s' "$BODY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),\"sessionId\":$(printf '%s' "$SESSION" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}")

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "${URL}/api/push/send" \
  -H "Authorization: Bearer ${SECRET}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESP=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Notification sent: $TITLE"
else
  echo "Failed (HTTP $HTTP_CODE): $BODY_RESP" >&2
  exit 1
fi
