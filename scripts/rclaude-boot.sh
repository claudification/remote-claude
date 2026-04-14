#!/usr/bin/env bash
#
# rclaude-boot.sh - Smart launcher for rclaude in tmux
#
# Tries --continue first (resume existing session). If that fails
# QUICKLY (no session to continue), starts fresh without --continue.
#
# Does NOT retry if --continue ran for a while and then exited -
# that's a real exit (user quit, SIGTERM, crash), not "nothing to continue".
#
# Usage: rclaude-boot.sh [rclaude args...]
#   e.g. rclaude-boot.sh --dangerously-skip-permissions
#

ARGS=("$@")
START_TIME=$(date +%s)

# Try --continue first to resume the last session in this CWD.
# If RCLAUDE_SESSION_ID is set, pass --resume with explicit ID/name.
# --continue picks "last session in CWD" (may be wrong after /clear).
# --resume resumes a specific session (CC 2.1+).
# ALWAYS use the session ID (CC's internal ID), never the rclaude session name.
# Session names like "raging-walrus" are rclaude concepts - CC doesn't know them
# and falls into an interactive fuzzy picker that hangs forever in tmux.
if [[ -n "${RCLAUDE_SESSION_ID:-}" ]]; then
  rclaude "${ARGS[@]}" --resume "$RCLAUDE_SESSION_ID"
else
  rclaude "${ARGS[@]}" --continue
fi
EXIT_CODE=$?

ELAPSED=$(( $(date +%s) - START_TIME ))

# Only fall through to fresh if --continue failed QUICKLY (within 5 seconds).
# A quick failure means "no session to continue in this directory" - safe to start fresh.
# A longer run that then exits means the session ran and ended intentionally
# (user quit, SIGTERM from dashboard, crash) - do NOT auto-spawn a replacement.
if [[ $EXIT_CODE -ne 0 && $ELAPSED -lt 5 ]]; then
  exec rclaude "${ARGS[@]}"
fi
