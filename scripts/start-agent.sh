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
SPAWN_ROOT_SET=false
KILL_IF_RUNNING=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --concentrator) AGENT_ARGS+=(--concentrator "$2"); shift 2 ;;
    --spawn-root)   AGENT_ARGS+=(--spawn-root "$2"); SPAWN_ROOT_SET=true; shift 2 ;;
    --no-spawn)     AGENT_ARGS+=(--no-spawn); shift ;;
    --kill-if-running) KILL_IF_RUNNING=true; shift ;;
    -v|--verbose)   AGENT_ARGS+=(-v); VERBOSE=true; shift ;;
    --help|-h)
      echo "Usage: start-agent.sh [--concentrator <url>] [--spawn-root <path>] [--no-spawn] [--kill-if-running] [-v|--verbose]"
      echo ""
      echo "Validates config and starts rclaude-agent in the background."
      echo "Reads RCLAUDE_SECRET and RCLAUDE_SPAWN_ROOT from .env or environment."
      echo ""
      echo "Spawn root priority: --spawn-root flag > \$RCLAUDE_SPAWN_ROOT > \$HOME"
      echo ""
      echo "Files:"
      echo "  .agent.pid  - PID of running agent"
      echo "  .agent.log  - Agent stdout/stderr"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

# Default spawn root: $RCLAUDE_SPAWN_ROOT > $HOME (--spawn-root flag overrides both)
if [[ "$SPAWN_ROOT_SET" == false && -n "${RCLAUDE_SPAWN_ROOT:-}" ]]; then
  AGENT_ARGS+=(--spawn-root "$RCLAUDE_SPAWN_ROOT")
fi

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
    if [[ "$KILL_IF_RUNNING" == true ]]; then
      warn "Killing existing agent (PID $OLD_PID)"
      kill "$OLD_PID" 2>/dev/null || true
      # Wait up to 3s for clean exit
      for i in {1..6}; do
        kill -0 "$OLD_PID" 2>/dev/null || break
        sleep 0.5
      done
      # Force kill if still alive
      if kill -0 "$OLD_PID" 2>/dev/null; then
        warn "Agent didn't exit cleanly, sending SIGKILL"
        kill -9 "$OLD_PID" 2>/dev/null || true
      fi
      rm -f "$PID_FILE"
    else
      warn "Agent already running (PID $OLD_PID)"
      echo -e "  Stop it first: ${YELLOW}kill $OLD_PID${NC}  or use --kill-if-running"
      exit 1
    fi
  else
    warn "Stale PID file (process $OLD_PID dead). Removing."
    rm -f "$PID_FILE"
  fi
fi

ok "RCLAUDE_SECRET is set"
ok "Agent binary: $AGENT_BIN"
ok "Revive script: $REVIVE_SCRIPT"

# --- Clean environment ---
# Agent may be launched from within a Claude Code session (e.g. user runs
# start-agent.sh from Claude). Claude sets CLAUDECODE env var which prevents
# nested sessions. Unset all Claude-inherited vars so spawned sessions work.
while IFS='=' read -r name _; do
  [[ "$name" == CLAUDECODE || "$name" == CLAUDE_CODE_* ]] && unset "$name"
done < <(env)

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
