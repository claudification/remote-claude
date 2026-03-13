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
#   0 = success (continued existing session)
#   1 = success (fresh session, --continue failed)
#   2 = error (directory not found)
#   3 = error (tmux spawn failed)

set -euo pipefail

SESSION_ID="$1"
CWD="$2"

# Derive tmux session name from last 2 path segments (max 20 chars)
tmux_name() {
  local segments
  IFS='/' read -ra segments <<< "$1"
  local len=${#segments[@]}
  local name=""

  if (( len >= 2 )); then
    name="${segments[$((len-2))]}/${segments[$((len-1))]}"
  elif (( len == 1 )); then
    name="${segments[0]}"
  else
    name="rclaude"
  fi

  # Truncate to 20 chars, prioritizing right segment
  if (( ${#name} > 20 )); then
    local right="${segments[$((len-1))]}"
    if (( ${#right} >= 20 )); then
      name="${right:0:20}"
    else
      local budget=$(( 20 - ${#right} - 1 ))
      if (( budget > 0 )); then
        name="${segments[$((len-2))]:0:$budget}/${right}"
      else
        name="${right}"
      fi
    fi
  fi

  # tmux session names can't have dots or colons
  echo "${name//[.:]/-}"
}

# Validate directory exists
if [[ ! -d "$CWD" ]]; then
  echo "ERROR: Directory not found: $CWD" >&2
  exit 2
fi

TMUX_NAME="remote-claude"
BASE_CMD="rclaude --dangerously-skip-permissions"

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

CONTINUE_CMD="${WRAPPER_PREFIX}$BASE_CMD --continue"
FRESH_CMD="${WRAPPER_PREFIX}$BASE_CMD"

# Count tmux windows in our session (0 if session doesn't exist)
window_count() {
  tmux list-windows -t "$TMUX_NAME" 2>/dev/null | wc -l | tr -d ' '
}

# Launch a command in tmux (new window or new session as needed).
# Returns 0 on success, 1 on failure.
tmux_launch() {
  local cmd="$1"
  if tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
    tmux new-window "${TMUX_ENV[@]}" -t "$TMUX_NAME" -c "$CWD" "$cmd"
  else
    tmux new-session -d "${TMUX_ENV[@]}" -s "$TMUX_NAME" -c "$CWD" "$cmd"
  fi
}

# Verify the spawned window survived startup.
# If the command exits immediately (e.g. --continue with no prior session),
# the window closes and the count drops back down.
verify_window_survived() {
  local before="$1"
  sleep 2
  local after
  after=$(window_count)
  (( after > before ))
}

# Try with --continue first (continues most recent conversation in cwd)
BEFORE=$(window_count)
if tmux_launch "$CONTINUE_CMD" && verify_window_survived "$BEFORE"; then
  echo "TMUX_SESSION=$TMUX_NAME"
  echo "CONTINUED=true"
  exit 0
fi

# Fallback: fresh session without --continue
if tmux_launch "$FRESH_CMD"; then
  echo "TMUX_SESSION=$TMUX_NAME"
  echo "CONTINUED=false"
  exit 1
fi

echo "ERROR: Failed to create tmux session" >&2
exit 3
