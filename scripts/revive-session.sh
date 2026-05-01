#!/usr/bin/env bash
#
# revive-session.sh - Revive/spawn a Claude Code session in tmux
#
# Called by sentinel when the dashboard requests a session revival or spawn.
# Customize this script to change tmux behavior, rclaude flags, etc.
#
# Usage: revive-session.sh <session-id> <cwd> [--mode fresh|resume] [--resume-id <claude-session-id>] [--resume-name <session-name>]
#
# Modes:
#   fresh    - Start a new session (default for spawn, uses --session-id for deterministic ID)
#   resume   - Resume a specific Claude session by ID (claude --resume <id>)
#
# Exit codes:
#   0 = success
#   2 = error (directory not found)
#   3 = error (tmux spawn failed)

set -euo pipefail

# Ensure package-manager-installed binaries (tmux, etc.) are on PATH even when
# running as a launchd/systemd service, which inherits a minimal PATH.
for dir in /opt/homebrew/bin /usr/local/bin /home/linuxbrew/.linuxbrew/bin "$HOME/.linuxbrew/bin"; do
  [[ -d "$dir" ]] && [[ ":$PATH:" != *":$dir:"* ]] && export PATH="$dir:$PATH"
done

CWD="$2"
SPAWN_MODE=""
RESUME_ID=""
RESUME_NAME=""

# Parse optional flags after positional args
shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) SPAWN_MODE="$2"; shift 2 ;;
    --resume-id) RESUME_ID="$2"; shift 2 ;;
    --resume-name) RESUME_NAME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Validate directory exists
if [[ ! -d "$CWD" ]]; then
  echo "ERROR: Directory not found: $CWD" >&2
  exit 2
fi

TMUX_NAME="claudewerk"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Build the launch command based on spawn mode
case "$SPAWN_MODE" in
  resume)
    # Resume a specific Claude session by CC session ID (not rclaude session name).
    # rclaude names like "raging-walrus" are unknown to CC and cause interactive picker hang.
    RESUME_KEY="${RESUME_ID:-$RESUME_NAME}"
    BASE_CMD="rclaude --dangerously-skip-permissions --resume $RESUME_KEY"
    ;;
  fresh|*)
    # Fresh start - direct rclaude, no boot script
    BASE_CMD="rclaude --dangerously-skip-permissions"
    ;;
esac

# Unset Claude Code env vars that prevent nested sessions.
# Agent may inherit these if launched from within a Claude session.
while IFS='=' read -r name _; do
  [[ "$name" == CLAUDECODE || "$name" == CLAUDE_CODE_* ]] && unset "$name"
done < <(env)

# Build tmux env flags - pass RCLAUDE_SECRET only
# RCLAUDE_CONVERSATION_ID is passed inline to the command (not tmux env) to prevent
# it from leaking to other tmux windows/sessions launched later
TMUX_ENV=()
if [[ -n "${RCLAUDE_SECRET:-}" ]]; then
  TMUX_ENV+=(-e "RCLAUDE_SECRET=$RCLAUDE_SECRET")
fi
# Prefix the command with env vars scoped to THIS process only
# (not tmux -e, which leaks to other windows launched later)
CMD_PREFIX=""
if [[ -n "${RCLAUDE_CONVERSATION_ID:-}" ]]; then
  CMD_PREFIX+="RCLAUDE_CONVERSATION_ID=$RCLAUDE_CONVERSATION_ID "
fi
if [[ -n "${RCLAUDE_SESSION_ID:-}" ]]; then
  CMD_PREFIX+="RCLAUDE_SESSION_ID=$RCLAUDE_SESSION_ID "
fi
if [[ "${RCLAUDE_HEADLESS:-}" == "1" ]]; then
  CMD_PREFIX+="RCLAUDE_HEADLESS=1 "
fi
if [[ "${RCLAUDE_BARE:-}" == "1" ]]; then
  CMD_PREFIX+="RCLAUDE_BARE=1 "
fi
# Session name passed as env var (not CLI flag) to avoid quoting hell in tmux -c "..."
# Strip quotes and backslashes to prevent shell injection in nested tmux command chains
if [[ -n "${CLAUDWERK_CONVERSATION_NAME:-}" ]]; then
  SAFE_SESSION_NAME="${CLAUDWERK_CONVERSATION_NAME//[\"\'\`\\]/}"
  CMD_PREFIX+="CLAUDWERK_CONVERSATION_NAME='${SAFE_SESSION_NAME}' "
fi
# Permission mode passed as env var for the same reason
if [[ -n "${RCLAUDE_PERMISSION_MODE:-}" ]]; then
  CMD_PREFIX+="RCLAUDE_PERMISSION_MODE=${RCLAUDE_PERMISSION_MODE} "
fi
# Autocompact threshold override (CC env var)
if [[ -n "${RCLAUDE_AUTOCOMPACT_PCT:-}" ]]; then
  CMD_PREFIX+="CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${RCLAUDE_AUTOCOMPACT_PCT} "
fi
# Ad-hoc task runner env vars
if [[ "${RCLAUDE_ADHOC:-}" == "1" ]]; then
  CMD_PREFIX+="RCLAUDE_ADHOC=1 "
fi
if [[ -n "${RCLAUDE_ADHOC_TASK_ID:-}" ]]; then
  CMD_PREFIX+="RCLAUDE_ADHOC_TASK_ID=${RCLAUDE_ADHOC_TASK_ID} "
fi
if [[ -n "${RCLAUDE_INITIAL_PROMPT_FILE:-}" ]]; then
  CMD_PREFIX+="RCLAUDE_INITIAL_PROMPT_FILE=${RCLAUDE_INITIAL_PROMPT_FILE} "
fi
# Worktree name forwarded so the wrapper can include it in SessionMeta
if [[ -n "${RCLAUDE_WORKTREE:-}" ]]; then
  SAFE_WORKTREE="${RCLAUDE_WORKTREE//[\"\'\`\\]/}"
  CMD_PREFIX+="RCLAUDE_WORKTREE='${SAFE_WORKTREE}' "
fi

# Append --effort flag if set (passed through to claude CLI)
EFFORT_FLAG=""
if [[ -n "${RCLAUDE_EFFORT:-}" ]]; then
  EFFORT_FLAG=" --effort $RCLAUDE_EFFORT"
fi

# Append --model flag if set (passed through to claude CLI)
MODEL_FLAG=""
if [[ -n "${RCLAUDE_MODEL:-}" ]]; then
  MODEL_FLAG=" --model $RCLAUDE_MODEL"
fi

# Append --agent flag if set (passed through to claude CLI)
AGENT_FLAG=""
if [[ -n "${RCLAUDE_AGENT:-}" ]]; then
  AGENT_FLAG=" --agent $RCLAUDE_AGENT"
fi

# Append --worktree flag if set (passed through to claude CLI for ad-hoc isolation)
WORKTREE_FLAG=""
if [[ -n "${RCLAUDE_WORKTREE:-}" ]]; then
  WORKTREE_FLAG=" --worktree $RCLAUDE_WORKTREE"
fi

# Append --max-budget-usd flag if set (headless only, passed through to claude CLI)
MAX_BUDGET_FLAG=""
if [[ -n "${RCLAUDE_MAX_BUDGET_USD:-}" ]]; then
  MAX_BUDGET_FLAG=" --max-budget-usd $RCLAUDE_MAX_BUDGET_USD"
fi

SPAWN_CMD="${CMD_PREFIX}${BASE_CMD}${EFFORT_FLAG}${MODEL_FLAG}${AGENT_FLAG}${WORKTREE_FLAG}${MAX_BUDGET_FLAG}"

# Debug log for launch diagnostics
if [[ "${RCLAUDE_ADHOC:-}" == "1" ]]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [AD-HOC] CWD=$CWD TASK=${RCLAUDE_ADHOC_TASK_ID:-none} PROMPT_FILE=${RCLAUDE_INITIAL_PROMPT_FILE:-none} WORKTREE=${RCLAUDE_WORKTREE:-none} CMD=$SPAWN_CMD" >> /tmp/concentrator-launch-log.log 2>/dev/null || true
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') CWD=$CWD CMD=$SPAWN_CMD" >> /tmp/concentrator-launch-log.log 2>/dev/null || true
fi

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
  # -P -F '#{pane_id}' outputs the globally-unique pane ID (%NNN) for health checking.
  # Pane IDs are stable regardless of session/window renames.
  local pane_id
  if tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
    pane_id=$(tmux new-window -P -F '#{pane_id}' "${TMUX_ENV[@]}" -t "$TMUX_NAME" -c "$CWD" "$wrapped")
  else
    pane_id=$(tmux new-session -d -P -F '#{pane_id}' "${TMUX_ENV[@]}" -s "$TMUX_NAME" -c "$CWD" "$wrapped")
  fi
  echo "PANE_ID=$pane_id"
}

if tmux_launch "$SPAWN_CMD"; then
  echo "TMUX_SESSION=$TMUX_NAME"
  exit 0
fi

echo "ERROR: Failed to create tmux session" >&2
exit 3
