#!/usr/bin/env bash
#
# revive-session.sh - Revive/spawn a Claude Code session in tmux
#
# Called by rclaude-agent when the dashboard requests a session revival or spawn.
# Customize this script to change tmux behavior, rclaude flags, etc.
#
# Usage: revive-session.sh <session-id> <cwd> [--mode fresh|continue|resume] [--resume-id <claude-session-id>]
#
# Modes:
#   fresh    - Start a new session (default for spawn, uses --session-id for deterministic ID)
#   continue - Resume the most recent session in the CWD (claude --continue)
#   resume   - Resume a specific Claude session by ID (claude --resume <id>)
#
# Exit codes:
#   0 = success
#   2 = error (directory not found)
#   3 = error (tmux spawn failed)

set -euo pipefail

CWD="$2"
SPAWN_MODE=""
RESUME_ID=""

# Parse optional flags after positional args
shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) SPAWN_MODE="$2"; shift 2 ;;
    --resume-id) RESUME_ID="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Validate directory exists
if [[ ! -d "$CWD" ]]; then
  echo "ERROR: Directory not found: $CWD" >&2
  exit 2
fi

TMUX_NAME="remote-claude"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Build the launch command based on spawn mode
case "$SPAWN_MODE" in
  resume)
    # Resume a specific Claude session by ID - direct rclaude, no boot script
    BASE_CMD="rclaude --dangerously-skip-permissions --resume $RESUME_ID"
    ;;
  continue)
    # Resume the most recent session in this CWD - direct rclaude, no boot script
    BASE_CMD="rclaude --dangerously-skip-permissions --continue"
    ;;
  fresh)
    # Fresh start - direct rclaude, no boot script
    BASE_CMD="rclaude --dangerously-skip-permissions"
    ;;
  *)
    # Default: use rclaude-boot.sh which tries --continue first, falls back to fresh
    BASE_CMD="$SCRIPT_DIR/rclaude-boot.sh --dangerously-skip-permissions"
    ;;
esac

# Unset Claude Code env vars that prevent nested sessions.
# Agent may inherit these if launched from within a Claude session.
while IFS='=' read -r name _; do
  [[ "$name" == CLAUDECODE || "$name" == CLAUDE_CODE_* ]] && unset "$name"
done < <(env)

# Build tmux env flags - pass RCLAUDE_SECRET only
# RCLAUDE_WRAPPER_ID is passed inline to the command (not tmux env) to prevent
# it from leaking to other tmux windows/sessions launched later
TMUX_ENV=()
if [[ -n "${RCLAUDE_SECRET:-}" ]]; then
  TMUX_ENV+=(-e "RCLAUDE_SECRET=$RCLAUDE_SECRET")
fi
# Prefix the command with env vars scoped to THIS process only
# (not tmux -e, which leaks to other windows launched later)
CMD_PREFIX=""
if [[ -n "${RCLAUDE_WRAPPER_ID:-}" ]]; then
  CMD_PREFIX+="RCLAUDE_WRAPPER_ID=$RCLAUDE_WRAPPER_ID "
fi
if [[ -n "${RCLAUDE_SESSION_ID:-}" ]]; then
  CMD_PREFIX+="RCLAUDE_SESSION_ID=$RCLAUDE_SESSION_ID "
fi
if [[ "${RCLAUDE_HEADLESS:-}" == "1" ]]; then
  CMD_PREFIX+="RCLAUDE_HEADLESS=1 "
fi

# Append --effort flag if set (passed through to claude CLI)
EFFORT_FLAG=""
if [[ -n "${RCLAUDE_EFFORT:-}" ]]; then
  EFFORT_FLAG=" --effort $RCLAUDE_EFFORT"
fi

SPAWN_CMD="${CMD_PREFIX}${BASE_CMD}${EFFORT_FLAG}"

# Launch a command in tmux via a login shell so .zshrc/.zprofile are sourced.
# Without this, the tmux pane runs the command directly (no shell init),
# missing env vars like API keys, FNM_*, XDG_CONFIG_HOME, etc.
tmux_launch() {
  local cmd="$1"
  # tmux pane commands run non-interactively by default. We need both:
  #   -l (login) to source .zprofile
  #   -i (interactive) to source .zshrc (where env vars like FNM_DIR,
  #      ZPFX, API keys are typically set via plugins/zinit/etc)
  local shell_path="${SHELL:-/bin/zsh}"
  local wrapped="${shell_path} -li -c \"${cmd}\""
  if tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
    tmux new-window "${TMUX_ENV[@]}" -t "$TMUX_NAME" -c "$CWD" "$wrapped"
  else
    tmux new-session -d "${TMUX_ENV[@]}" -s "$TMUX_NAME" -c "$CWD" "$wrapped"
  fi
}

# Always spawn fresh - the --continue path had a race condition where both
# --continue and fresh could launch simultaneously (--continue dies after 2s
# verify window but before tmux cleans up, fresh launches alongside it)
if tmux_launch "$SPAWN_CMD"; then
  echo "TMUX_SESSION=$TMUX_NAME"
  exit 0
fi

echo "ERROR: Failed to create tmux session" >&2
exit 3
