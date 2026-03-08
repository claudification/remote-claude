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

# Build tmux env flags - pass RCLAUDE_SECRET if set
TMUX_ENV=()
if [[ -n "${RCLAUDE_SECRET:-}" ]]; then
  TMUX_ENV+=(-e "RCLAUDE_SECRET=$RCLAUDE_SECRET")
fi

SESSION_EXISTS=false

if tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
  SESSION_EXISTS=true
fi

# Try with --continue first
CONTINUE_CMD="$BASE_CMD --continue"

if [[ "$SESSION_EXISTS" == true ]]; then
  # Add new window to existing tmux session
  if tmux new-window "${TMUX_ENV[@]}" -t "$TMUX_NAME" -c "$CWD" "$CONTINUE_CMD"; then
    echo "TMUX_SESSION=$TMUX_NAME"
    echo "CONTINUED=true"
    exit 0
  fi
else
  # Create new tmux session with --continue
  if tmux new-session -d "${TMUX_ENV[@]}" -s "$TMUX_NAME" -c "$CWD" "$CONTINUE_CMD"; then
    sleep 2
    if tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
      echo "TMUX_SESSION=$TMUX_NAME"
      echo "CONTINUED=true"
      exit 0
    fi
  fi
fi

# Fallback: fresh session without --continue
if tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
  SESSION_EXISTS=true
fi

if [[ "$SESSION_EXISTS" == true ]]; then
  if tmux new-window "${TMUX_ENV[@]}" -t "$TMUX_NAME" -c "$CWD" "$BASE_CMD"; then
    echo "TMUX_SESSION=$TMUX_NAME"
    echo "CONTINUED=false"
    exit 1
  fi
else
  if tmux new-session -d "${TMUX_ENV[@]}" -s "$TMUX_NAME" -c "$CWD" "$BASE_CMD"; then
    echo "TMUX_SESSION=$TMUX_NAME"
    echo "CONTINUED=false"
    exit 1
  fi
fi

echo "ERROR: Failed to create tmux session" >&2
exit 3
