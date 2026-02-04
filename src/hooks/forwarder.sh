#!/bin/bash
# Hook forwarder script for rclaude
# Posts hook data to the wrapper's local HTTP server
#
# Environment variables expected:
#   RCLAUDE_PORT       - Port of the local HTTP server
#   RCLAUDE_SESSION_ID - Session ID for this claude instance
#
# Hook event type is passed as first argument by rclaude

HOOK_EVENT="${1:-unknown}"
PORT="${RCLAUDE_PORT:-19000}"
SESSION_ID="${RCLAUDE_SESSION_ID:-unknown}"

# Read stdin (hook JSON data) and POST to local server
curl -s -X POST "http://127.0.0.1:${PORT}/hook/${HOOK_EVENT}" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: ${SESSION_ID}" \
  -d @- \
  > /dev/null 2>&1

# Always exit 0 to not block claude
exit 0
