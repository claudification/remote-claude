#!/bin/bash
#
# worktree-create.sh - WorktreeCreate hook for Claude Code
#
# NOTE: Canonical source is embedded in src/shared/resolve-script.ts.
# This file is for dev/reference. Keep in sync with the embedded version.
#
# Creates git worktrees from LOCAL HEAD instead of origin/HEAD.
# CC defaults to origin/HEAD (last pushed commit), which creates
# stale branches when you have unpushed local commits.
#
# Input (stdin JSON from CC):
#   { session_id, transcript_path, cwd, hook_event_name, name }
#   - name: worktree name from --worktree flag
#   - cwd: project root directory
#
# Output: worktree path to stdout, exit 0 = success
#

set -euo pipefail

HOOK_DATA=$(cat)
WT_NAME=$(echo "$HOOK_DATA" | jq -r '.name // empty')

if [[ -z "$WT_NAME" ]]; then
  echo "ERROR: No worktree name in hook data" >&2
  exit 1
fi

PROJECT_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_PATH="$PROJECT_ROOT/.claude/worktrees/$WT_NAME"

# Ensure parent dir exists
mkdir -p "$(dirname "$WORKTREE_PATH")"

# Resolve base: local branch HEAD > main > fallback
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || echo '')"
if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  REAL_BASE="HEAD"
elif [[ -n "$CURRENT_BRANCH" ]]; then
  REAL_BASE="$CURRENT_BRANCH"
else
  REAL_BASE="main"
fi

REAL_BASE_SHA="$(git rev-parse "$REAL_BASE")"
BRANCH_NAME="worktree-$WT_NAME"
# CRITICAL: CC expects ONLY the worktree path on stdout.
# All other output (git, bun install, init scripts) MUST go to stderr.
git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" "$REAL_BASE_SHA" >&2

# Copy .worktreeinclude files (our hook replaces CC's native logic)
if [[ -f "$PROJECT_ROOT/.worktreeinclude" ]]; then
  while IFS= read -r pattern || [[ -n "$pattern" ]]; do
    [[ -z "$pattern" || "$pattern" == \#* ]] && continue
    # shellcheck disable=SC2086
    for file in $PROJECT_ROOT/$pattern; do
      [[ -f "$file" ]] || continue
      if git check-ignore -q "$file" 2>/dev/null; then
        REL="${file#$PROJECT_ROOT/}"
        mkdir -p "$(dirname "$WORKTREE_PATH/$REL")"
        cp "$file" "$WORKTREE_PATH/$REL"
      fi
    done
  done < "$PROJECT_ROOT/.worktreeinclude"
fi

# Run worktree-init.sh if it exists (all output to stderr)
INIT_SCRIPT="$PROJECT_ROOT/worktree-init.sh"
if [[ -x "$INIT_SCRIPT" ]]; then
  "$INIT_SCRIPT" "$WORKTREE_PATH" >&2 || echo "WARNING: worktree-init.sh failed" >&2
elif [[ -f "$INIT_SCRIPT" ]]; then
  bash "$INIT_SCRIPT" "$WORKTREE_PATH" >&2 || echo "WARNING: worktree-init.sh failed" >&2
fi

# ONLY output: the worktree path
echo "$WORKTREE_PATH"
