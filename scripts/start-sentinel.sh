#!/usr/bin/env bash
#
# start-sentinel.sh - Start sentinel with validation
#
# Validates config, starts sentinel as background process, writes PID.
#
# Usage: start-sentinel.sh [--concentrator <url>] [-v|--verbose]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

# Prefer the dogfood install (`bun install -g ./packages/sentinel`) over the
# local compiled binary -- we eat what we ship. Falls back to `bin/sentinel`
# if the global install isn't set up.
if SENTINEL_BIN="$(command -v sentinel 2>/dev/null)" && [[ -n "$SENTINEL_BIN" ]]; then
  : # using global install (dogfood)
else
  SENTINEL_BIN="$PROJECT_DIR/bin/sentinel"
fi
PID_FILE="$PROJECT_DIR/.sentinel.pid"
LOG_FILE="$PROJECT_DIR/.sentinel.log"

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
SENTINEL_ARGS=()
VERBOSE=false
SPAWN_ROOT_SET=false
KILL_IF_RUNNING=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --concentrator) SENTINEL_ARGS+=(--concentrator "$2"); shift 2 ;;
    --spawn-root)   SENTINEL_ARGS+=(--spawn-root "$2"); SPAWN_ROOT_SET=true; shift 2 ;;
    --no-spawn)     SENTINEL_ARGS+=(--no-spawn); shift ;;
    --kill-if-running) KILL_IF_RUNNING=true; shift ;;
    -v|--verbose)   SENTINEL_ARGS+=(-v); VERBOSE=true; shift ;;
    --help|-h)
      echo "Usage: start-sentinel.sh [--concentrator <url>] [--spawn-root <path>] [--no-spawn] [--kill-if-running] [-v|--verbose]"
      echo ""
      echo "Validates config and starts sentinel in the background."
      echo "Reads RCLAUDE_SECRET and RCLAUDE_SPAWN_ROOT from .env or environment."
      echo ""
      echo "Spawn root priority: --spawn-root flag > \$RCLAUDE_SPAWN_ROOT > \$HOME"
      echo ""
      echo "Files:"
      echo "  .sentinel.pid  - PID of running sentinel"
      echo "  .sentinel.log  - Sentinel stdout/stderr"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

# Default spawn root: $RCLAUDE_SPAWN_ROOT > $HOME (--spawn-root flag overrides both)
if [[ "$SPAWN_ROOT_SET" == false && -n "${RCLAUDE_SPAWN_ROOT:-}" ]]; then
  SENTINEL_ARGS+=(--spawn-root "$RCLAUDE_SPAWN_ROOT")
fi

# --- Validation ---

# Binary exists
[[ -x "$SENTINEL_BIN" ]] || die "Sentinel binary not found: $SENTINEL_BIN (run: bun run build:packages && bun install -g ./packages/sentinel  -- or fall back to: bun run build:sentinel)"

# Secret is set
[[ -n "${RCLAUDE_SECRET:-}" ]] || die "RCLAUDE_SECRET not set. Set in .env or environment."

# Revive script exists
REVIVE_SCRIPT="$SCRIPT_DIR/revive-session.sh"
[[ -x "$REVIVE_SCRIPT" ]] || die "Revive script not found or not executable: $REVIVE_SCRIPT"

# tmux available
command -v tmux &>/dev/null || die "tmux not found. Install with: brew install tmux"

# Check for already running sentinel
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    if [[ "$KILL_IF_RUNNING" == true ]]; then
      warn "Killing existing sentinel (PID $OLD_PID)"
      kill "$OLD_PID" 2>/dev/null || true
      # Wait up to 3s for clean exit
      for i in {1..6}; do
        kill -0 "$OLD_PID" 2>/dev/null || break
        sleep 0.5
      done
      # Force kill if still alive
      if kill -0 "$OLD_PID" 2>/dev/null; then
        warn "Sentinel didn't exit cleanly, sending SIGKILL"
        kill -9 "$OLD_PID" 2>/dev/null || true
      fi
      rm -f "$PID_FILE"
    else
      warn "Sentinel already running (PID $OLD_PID)"
      echo -e "  Stop it first: ${YELLOW}kill $OLD_PID${NC}  or use --kill-if-running"
      exit 1
    fi
  else
    warn "Stale PID file (process $OLD_PID dead). Removing."
    rm -f "$PID_FILE"
  fi
fi

ok "RCLAUDE_SECRET is set"
ok "Sentinel binary: $SENTINEL_BIN"
ok "Revive script: $REVIVE_SCRIPT"

# --- Clean environment ---
# Sentinel may be launched from within a Claude Code session (e.g. user runs
# start-sentinel.sh from Claude). Unset all Claude-inherited and session-scoped
# RCLAUDE_* vars so they don't leak into spawned sessions.
# Keep: RCLAUDE_SECRET, RCLAUDE_BROKER, RCLAUDE_SPAWN_ROOT (config vars)
while IFS='=' read -r name _; do
  [[ "$name" == CLAUDECODE || "$name" == CLAUDE_CODE_* ]] && unset "$name"
done < <(env)
for _var in RCLAUDE_HEADLESS RCLAUDE_CONVERSATION_ID RCLAUDE_SESSION_ID \
            CLAUDWERK_CONVERSATION_NAME RCLAUDE_BARE RCLAUDE_ADHOC \
            RCLAUDE_ADHOC_TASK_ID RCLAUDE_CHANNELS RCLAUDE_INITIAL_PROMPT_FILE \
            RCLAUDE_WORKTREE RCLAUDE_EFFORT RCLAUDE_MODEL RCLAUDE_PORT \
            RCLAUDE_AUTOCOMPACT_PCT RCLAUDE_MAX_BUDGET_USD \
            RCLAUDE_PERMISSION_MODE; do
  unset "$_var"
done

# --- Start ---

"$SENTINEL_BIN" ${SENTINEL_ARGS[@]+"${SENTINEL_ARGS[@]}"} >> "$LOG_FILE" 2>&1 &
SENTINEL_PID=$!

# Verify it didn't die immediately
sleep 0.5
if ! kill -0 "$SENTINEL_PID" 2>/dev/null; then
  die "Sentinel died immediately. Check $LOG_FILE"
fi

echo "$SENTINEL_PID" > "$PID_FILE"

ok "Sentinel started (PID $SENTINEL_PID)"
echo "  Log: $LOG_FILE"
echo "  PID: $PID_FILE"
echo "  Stop: kill $SENTINEL_PID"
