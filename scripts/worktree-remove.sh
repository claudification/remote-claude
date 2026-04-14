#!/bin/bash
#
# worktree-remove.sh - WorktreeRemove hook
#
# NOTE: Canonical source is embedded in src/shared/resolve-script.ts.
# This file is for dev/reference. Keep in sync with the embedded version.
#
# BLOCKS removal if the worktree branch has unmerged commits.
# Only allows removal when all work has been merged to main.
#
# Input (stdin JSON from CC):
#   { session_id, cwd, hook_event_name, name, path }
#

set -euo pipefail

HOOK_DATA=$(cat)
WT_NAME=$(echo "$HOOK_DATA" | jq -r '.name // "unknown"')
WT_PATH=$(echo "$HOOK_DATA" | jq -r '.path // empty')

# Fallback: derive path from name + cwd
if [[ -z "$WT_PATH" ]]; then
  WT_CWD=$(echo "$HOOK_DATA" | jq -r '.cwd // empty')
  if [[ -n "$WT_CWD" && -n "$WT_NAME" && "$WT_NAME" != "unknown" ]]; then
    WT_PATH="$WT_CWD/.claude/worktrees/$WT_NAME"
  fi
fi

if [[ -z "$WT_PATH" || ! -d "$WT_PATH" ]]; then
  # Worktree already gone or never created -- allow removal
  exit 0
fi

cd "$WT_PATH" 2>/dev/null || exit 0

BRANCH="$(git branch --show-current 2>/dev/null || echo '')"
MAIN_BRANCH="main"
git rev-parse --verify main >/dev/null 2>&1 || MAIN_BRANCH="master"

if [[ -n "$BRANCH" ]]; then
  UNCOMMITTED="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  AHEAD="$(git rev-list --count "$MAIN_BRANCH..HEAD" 2>/dev/null || echo 0)"

  if [[ "$UNCOMMITTED" -gt 0 ]]; then
    echo "BLOCKED: Worktree $BRANCH has $UNCOMMITTED uncommitted files. Commit or discard first." >&2
    exit 1
  fi

  if [[ "$AHEAD" -gt 0 ]]; then
    # Try fast-forward merge before blocking
    if git fetch . "HEAD:$MAIN_BRANCH" 2>/dev/null; then
      echo "Auto-merged $AHEAD commits from $BRANCH to $MAIN_BRANCH before removal" >&2
    else
      echo "BLOCKED: Worktree $BRANCH has $AHEAD unmerged commits that cannot be fast-forwarded to $MAIN_BRANCH. Merge first." >&2
      exit 1
    fi
  fi
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') REMOVE worktree=$WT_NAME branch=$BRANCH (merged)" >> /tmp/rclaude-worktree.log 2>/dev/null || true
exit 0
