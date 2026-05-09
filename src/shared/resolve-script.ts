/**
 * Script Resolver
 *
 * Resolves rclaude infrastructure scripts (worktree hooks, etc.) using a
 * layered lookup strategy. This ensures scripts are found whether rclaude
 * is running from a source checkout, installed globally, or distributed
 * as a compiled binary.
 *
 * Resolution order:
 *   1. $RCLAUDE_SCRIPTS/{name}         -- env override (dev, custom installs)
 *   2. $XDG_DATA_HOME/rclaude/scripts/{name}  -- XDG data dir (~/.local/share/rclaude/scripts/)
 *   3. Extract embedded script to /tmp/rclaude-scripts/{name}
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Embedded script contents (inlined at build time)
// These are the fallback when no external script is found.

const EMBEDDED_SCRIPTS: Record<string, string> = {
  'worktree-create.sh': `#!/bin/bash
#
# worktree-create.sh - WorktreeCreate hook for Claude Code
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
PROJECT_CWD=$(echo "$HOOK_DATA" | jq -r '.cwd // empty')

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
    [[ -z "$pattern" || "$pattern" == \\#* ]] && continue
    for file in $PROJECT_ROOT/$pattern; do
      [[ -f "$file" ]] || continue
      if git check-ignore -q "$file" 2>/dev/null; then
        REL="\${file#$PROJECT_ROOT/}"
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
`,

  'worktree-finish.sh': `#!/bin/bash
#
# worktree-finish.sh - Merge worktree branch back to main
#
# Rebases onto main, then fast-forwards main (no checkout needed).
# Exit 0 = success or nothing to merge, exit 1 = error.
#

set -euo pipefail

BRANCH="$(git branch --show-current)"
if [[ ! "$BRANCH" =~ ^worktree- ]]; then
  echo "Not in a worktree branch ($BRANCH)" >&2
  exit 1
fi

MAIN_BRANCH="main"
if ! git rev-parse --verify main >/dev/null 2>&1; then
  MAIN_BRANCH="master"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Uncommitted changes. Commit or stash first." >&2
  exit 1
fi

AHEAD="$(git rev-list --count "$MAIN_BRANCH"..HEAD)"
if [[ "$AHEAD" == "0" ]]; then
  echo "Nothing to merge -- worktree branch is even with $MAIN_BRANCH"
  exit 0
fi

echo "Rebasing $BRANCH onto $MAIN_BRANCH ($AHEAD commits ahead)..."
if ! git rebase "$MAIN_BRANCH"; then
  echo "ERROR: Rebase conflicts. Resolve them, then re-run this script." >&2
  exit 1
fi

echo "Fast-forwarding $MAIN_BRANCH..."
if ! git fetch . "HEAD:$MAIN_BRANCH"; then
  echo "ERROR: Cannot fast-forward $MAIN_BRANCH. Manual merge needed." >&2
  exit 1
fi

echo "Merged $AHEAD commits from $BRANCH into $MAIN_BRANCH"
`,

  'worktree-remove.sh': `#!/bin/bash
#
# worktree-remove.sh - WorktreeRemove hook
#
# BLOCKS removal if the worktree branch has unmerged commits.
# Only allows removal when all work has been merged to main.
#
# If CC delegates removal to this hook (like WorktreeCreate),
# exit 1 prevents the removal. If CC handles removal itself,
# we at least attempt a last-ditch fast-forward merge.
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
`,
}

/**
 * Default XDG data directory for rclaude scripts.
 * $XDG_DATA_HOME/rclaude/scripts/ (defaults to ~/.local/share/rclaude/scripts/)
 */
function xdgScriptsDir(): string {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(xdgData, 'rclaude', 'scripts')
}

/**
 * Resolve a script path using the layered lookup strategy.
 * Returns the absolute path to the script, or null if not found
 * and no embedded fallback exists.
 */
export function resolveScript(name: string): string | null {
  // 1. $RCLAUDE_SCRIPTS override
  const envDir = process.env.RCLAUDE_SCRIPTS
  if (envDir) {
    const envPath = join(envDir, name)
    if (existsSync(envPath)) return envPath
  }

  // 2. XDG data dir
  const xdgPath = join(xdgScriptsDir(), name)
  if (existsSync(xdgPath)) return xdgPath

  // 3. Extract embedded fallback to /tmp/rclaude-scripts/
  const embedded = EMBEDDED_SCRIPTS[name]
  if (!embedded) return null

  // Content-hash the filename so different rclaude versions (or concurrent
  // processes) never collide or stomp each other's scripts.
  const hash = createHash('sha256').update(embedded).digest('hex').slice(0, 12)
  const base = name.replace(/\.sh$/, '')
  const tmpDir = '/tmp/rclaude-scripts'
  const tmpPath = join(tmpDir, `${base}-${hash}.sh`)

  if (!existsSync(tmpPath)) {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(tmpPath, embedded, { mode: 0o755 })
  }

  return tmpPath
}

/**
 * Install embedded scripts to the XDG data directory.
 * Called by `rclaude --install-scripts` or during first run.
 * Returns the directory where scripts were installed.
 */
function _installScripts(): string {
  const dir = xdgScriptsDir()
  mkdirSync(dir, { recursive: true })

  for (const [name, content] of Object.entries(EMBEDDED_SCRIPTS)) {
    const path = join(dir, name)
    writeFileSync(path, content, { mode: 0o755 })
  }

  return dir
}

/**
 * List all available script names.
 */
function _listScriptNames(): string[] {
  return Object.keys(EMBEDDED_SCRIPTS)
}
