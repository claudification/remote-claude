#!/usr/bin/env bash
#
# revive-session.sh - Revive a Claude Code session in tmux
#
# Called by rclaude-agent when the dashboard requests a session revival.
# Customize this script to change tmux behavior, rclaude flags, etc.
#
# Usage: revive-session.sh <session-id> <cwd>
#
# Exit codes:
#   0 = success
#   2 = error (directory not found)
#   3 = error (tmux spawn failed)

set -euo pipefail

CWD="$2"

# Validate directory exists
if [[ ! -d "$CWD" ]]; then
  echo "ERROR: Directory not found: $CWD" >&2
  exit 2
fi

TMUX_NAME="remote-claude"
BASE_CMD="rclaude --dangerously-skip-permissions"

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
# Prefix the command with RCLAUDE_WRAPPER_ID=... so it's scoped to THIS process only
WRAPPER_PREFIX=""
if [[ -n "${RCLAUDE_WRAPPER_ID:-}" ]]; then
  WRAPPER_PREFIX="RCLAUDE_WRAPPER_ID=$RCLAUDE_WRAPPER_ID "
fi

SPAWN_CMD="${WRAPPER_PREFIX}$BASE_CMD"

# Launch a command in tmux via a login shell so .zshrc/.zprofile are sourced.
# Without this, the tmux pane runs the command directly (no shell init),
# missing env vars like API keys, FNM_*, XDG_CONFIG_HOME, etc.
tmux_launch() {
  local cmd="$1"
  # tmux passes commands to sh -c by default. We wrap in a login shell
  # invocation so the user's profile is sourced before running rclaude.
  # Using $SHELL (or zsh fallback) with -l for login + -c for command.
  local shell_path="${SHELL:-/bin/zsh}"
  local wrapped="${shell_path} -l -c \"${cmd}\""
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
