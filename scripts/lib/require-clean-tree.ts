#!/usr/bin/env bun
// Refuses to proceed if the git working tree is dirty.
//
// Why: builds that include uncommitted changes ship un-rollback-able artifacts
// (no commit SHA to roll back TO). Multi-session repos see this constantly --
// any Claude session running a build can bake another session's WIP into the
// output. The fix is to make WIP a build-time hard error.
//
// Skips when there is no git repo (Docker build, tarball checkout, etc.) --
// in that case the caller is presumed to be running on an artifact built by
// the host wrapper, which already enforced the check.

import { spawnSync } from 'node:child_process'

export interface CleanTreeOptions {
  /** Label to print in error messages. e.g. 'build:broker' */
  label: string
  /** Pass --force-dirty (or equivalent) to override the refusal. */
  forceDirty: boolean
  /**
   * Files that are ALWAYS considered untracked artifacts of the build itself
   * and ignored by the dirty check. Match against `git status --porcelain`
   * paths (relative to repo root).
   */
  ignorePaths?: string[]
}

export interface CleanTreeResult {
  /** Full commit SHA the build will reflect. */
  commit: string
  /** Short (7-char) commit SHA. */
  short: string
  /** Whether the tree was actually dirty (informational when forceDirty=true). */
  dirty: boolean
}

function run(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  }
}

export function requireCleanTree(repoRoot: string, opts: CleanTreeOptions): CleanTreeResult {
  const headCheck = run(['rev-parse', '--git-dir'], repoRoot)
  if (!headCheck.ok) {
    // No git here. Caller is inside a tarball/Docker build. The host wrapper
    // already enforced the check; trust the artifact.
    return { commit: 'unknown', short: 'unknown', dirty: false }
  }

  const head = run(['rev-parse', 'HEAD'], repoRoot)
  if (!head.ok) {
    throw new Error(`[${opts.label}] git rev-parse HEAD failed: ${head.stderr}`)
  }
  const commit = head.stdout
  const short = commit.slice(0, 7)

  const status = run(['status', '--porcelain'], repoRoot)
  if (!status.ok) {
    throw new Error(`[${opts.label}] git status failed: ${status.stderr}`)
  }

  const ignore = new Set(opts.ignorePaths ?? [])
  const dirtyLines = status.stdout
    .split('\n')
    .filter(l => l.length > 0)
    .filter(l => {
      // Porcelain format: "XY path" (X=index, Y=worktree)
      const path = l.slice(3)
      return !ignore.has(path)
    })

  const dirty = dirtyLines.length > 0
  if (!dirty) {
    return { commit, short, dirty: false }
  }

  // Tree is dirty. Print what won't be in the build.
  process.stderr.write(
    `\n[${opts.label}] Refusing to build: working tree is dirty.\n` +
      `  HEAD = ${short} -- this is the commit the build will reflect.\n` +
      `  The following files have uncommitted changes and will NOT be in the build:\n`,
  )
  for (const line of dirtyLines) {
    process.stderr.write(`    ${line}\n`)
  }

  if (opts.forceDirty) {
    process.stderr.write(
      `\n  --force-dirty was passed. Proceeding anyway.\n` +
        `  WARNING: the resulting artifact will be tagged ${short} but does NOT match commit ${short}.\n` +
        `  Commit your changes before publishing or deploying this build.\n\n`,
    )
    return { commit, short, dirty: true }
  }

  process.stderr.write(
    `\n  Commit your work first:  git add -A && git commit -m "wip"\n` +
      `  Or override (emergency only, e.g. hotfix you have not committed yet):\n` +
      `      bun run ${opts.label} -- --force-dirty\n\n`,
  )
  process.exit(1)
}

export function parseForceDirty(argv: string[]): boolean {
  return argv.includes('--force-dirty')
}
