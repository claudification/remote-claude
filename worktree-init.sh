#!/bin/bash
# worktree-init.sh -- rclaude project worktree setup
# Called by worktree-create.sh after git worktree is created.
# $1 = worktree path

WORKTREE="$1"
cd "$WORKTREE" || exit 1
bun install --frozen-lockfile 2>/dev/null || bun install
