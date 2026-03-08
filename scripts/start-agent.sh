#!/usr/bin/env bash
#
# start-agent.sh - Start rclaude-agent with validation
#
# Validates config, starts agent as background process, writes PID.
#
# Usage: start-agent.sh [--concentrator <url>] [-v|--verbose]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
AGENT_BIN="$PROJECT_DIR/bin/rclaude-agent"
ENV_FILE="$PROJECT_DIR/.env"
PID_FILE="$PROJECT_DIR/.agent.pid"
LOG_FILE="$PROJECT_DIR/.agent.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

die() { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }
ok()  { echo -e "${GREEN}OK:${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }

# Load .env if present
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Collect extra args to pass through
AGENT_ARGS=()
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --concentrator) AGENT_ARGS+=(--concentrator "$2"); shift 2 ;;
    -v|--verbose)   AGENT_ARGS+=(-v); VERBOSE=true; shift ;;
    --help|-h)
      echo "Usage: start-agent.sh [--concentrator <url>] [-v|--verbose]"
      echo ""
      echo "Validates config and starts rclaude-agent in the background."
      echo "Reads RCLAUDE_SECRET from .env or environment."
      echo ""
      echo "Files:"
      echo "  .agent.pid  - PID of running agent"
      echo "  .agent.log  - Agent stdout/stderr"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

# --- Validation ---

# Binary exists
[[ -x "$AGENT_BIN" ]] || die "Agent binary not found: $AGENT_BIN (run: bun run build:agent)"

# Secret is set
[[ -n "${RCLAUDE_SECRET:-}" ]] || die "RCLAUDE_SECRET not set. Set in .env or environment."

# Revive script exists
REVIVE_SCRIPT="$SCRIPT_DIR/revive-session.sh"
[[ -x "$REVIVE_SCRIPT" ]] || die "Revive script not found or not executable: $REVIVE_SCRIPT"

# tmux available
command -v tmux &>/dev/null || die "tmux not found. Install with: brew install tmux"

# Check for already running agent
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    warn "Agent already running (PID $OLD_PID)"
    echo -e "  Stop it first: ${YELLOW}kill $OLD_PID${NC}"
    exit 1
  else
    warn "Stale PID file (process $OLD_PID dead). Removing."
    rm -f "$PID_FILE"
  fi
fi

ok "RCLAUDE_SECRET is set"
ok "Agent binary: $AGENT_BIN"
ok "Revive script: $REVIVE_SCRIPT"

# --- Start ---

"$AGENT_BIN" ${AGENT_ARGS[@]+"${AGENT_ARGS[@]}"} >> "$LOG_FILE" 2>&1 &
AGENT_PID=$!

# Verify it didn't die immediately
sleep 0.5
if ! kill -0 "$AGENT_PID" 2>/dev/null; then
  die "Agent died immediately. Check $LOG_FILE"
fi

echo "$AGENT_PID" > "$PID_FILE"

ok "Agent started (PID $AGENT_PID)"
echo "  Log: $LOG_FILE"
echo "  PID: $PID_FILE"
echo "  Stop: kill $AGENT_PID"
