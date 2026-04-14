#!/bin/bash
#
# worktree-finish.sh - Merge worktree branch back to main
#
# NOTE: Canonical source is embedded in src/shared/resolve-script.ts.
# This file is for dev/reference. Keep in sync with the embedded version.
#
# Rebases the current worktree branch onto main, then fast-forwards
# main to include the worktree's work. No checkout needed.
#
# Usage: bash scripts/worktree-finish.sh
#
# Exit codes:
#   0 = success (or nothing to merge)
#   1 = error (uncommitted changes, rebase conflict, etc.)
#

set -euo pipefail

# Detect current state
BRANCH="$(git branch --show-current)"
if [[ ! "$BRANCH" =~ ^worktree- ]]; then
  echo "Not in a worktree branch ($BRANCH)" >&2
  exit 1
fi

# Find the main branch
MAIN_BRANCH="main"
if ! git rev-parse --verify main >/dev/null 2>&1; then
  MAIN_BRANCH="master"
fi

# Check if there are uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Uncommitted changes. Commit or stash first." >&2
  exit 1
fi

# Check untracked files too
UNTRACKED="$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"
if [[ "$UNTRACKED" -gt 0 ]]; then
  echo "WARNING: $UNTRACKED untracked files (not blocking merge)" >&2
fi

# Check if there's anything to merge
AHEAD="$(git rev-list --count "$MAIN_BRANCH"..HEAD)"
if [[ "$AHEAD" == "0" ]]; then
  echo "Nothing to merge -- worktree branch is even with $MAIN_BRANCH"
  exit 0
fi

# Rebase onto main
echo "Rebasing $BRANCH onto $MAIN_BRANCH ($AHEAD commits ahead)..."
if ! git rebase "$MAIN_BRANCH"; then
  echo "ERROR: Rebase conflicts. Resolve them, then run:" >&2
  echo "  git rebase --continue" >&2
  echo "  bash scripts/worktree-finish.sh" >&2
  exit 1
fi

# Fast-forward main to include our work (no checkout needed)
echo "Fast-forwarding $MAIN_BRANCH..."
if ! git fetch . "HEAD:$MAIN_BRANCH"; then
  echo "ERROR: Cannot fast-forward $MAIN_BRANCH. Manual merge needed." >&2
  exit 1
fi

echo "Merged $AHEAD commits from $BRANCH into $MAIN_BRANCH"
