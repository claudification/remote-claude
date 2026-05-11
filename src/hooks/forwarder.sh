#!/bin/bash
# Hook forwarder script for rclaude
# Posts hook data to the agent host's local HTTP server
#
# Environment variables expected:
#   RCLAUDE_PORT            - Port of the local HTTP server
#   RCLAUDE_CONVERSATION_ID - Conversation ID for this agent host instance
#
# Hook event type is passed as first argument by rclaude.
#
# Note: rclaude does NOT actually invoke this script at runtime -- it injects
# inline curl commands into ~/.claude/settings.json each boot via
# settings-merge.ts. This file is a standalone reference for users wiring up
# CC hooks by hand. The header name and env var match what rclaude emits.

HOOK_EVENT="${1:-unknown}"
PORT="${RCLAUDE_PORT:-19000}"
CONVERSATION_ID="${RCLAUDE_CONVERSATION_ID:-unknown}"

# Read stdin (hook JSON data) and POST to local server
curl -s -X POST "http://127.0.0.1:${PORT}/hook/${HOOK_EVENT}" \
  -H "Content-Type: application/json" \
  -H "X-Conversation-Id: ${CONVERSATION_ID}" \
  -d @- \
  > /dev/null 2>&1

# Always exit 0 to not block claude
exit 0
