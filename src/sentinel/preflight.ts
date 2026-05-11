/**
 * Spawn pre-flight checks.
 *
 * Catches scenarios that would otherwise produce cryptic CC failures (e.g.
 * `error_during_execution` 3s after boot with no useful diagnostic). Each
 * check is either HARD (abort spawn) or SOFT (warn + remember). Soft checks
 * cover assumptions about CC internals (file layouts etc.) that we don't
 * control -- they MAY become invalid as CC evolves, so we never abort on
 * them; instead the warning is stashed and surfaced if CC dies early after
 * launch as a likely cause.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type PreflightSeverity = 'fail' | 'warn'

export interface PreflightIssue {
  /** Stable identifier for the check that produced this issue. */
  check: string
  /** `fail` aborts the spawn; `warn` is informational. */
  severity: PreflightSeverity
  /** Short human-readable summary (shown in launch timeline). */
  message: string
  /** Optional structured detail for diagnostics (shown in (i) inspector). */
  detail?: Record<string, unknown>
}

export interface PreflightInput {
  cwd: string
  /** Optional worktree NAME (the `--worktree X` value), not a path. */
  worktree?: string
  /** Optional CC session ID for `--resume`. When set, we check the expected
   *  transcript-slug location (soft). */
  resumeCcSessionId?: string
  /** Optional override for `git`. Defaults to the binary on PATH. */
  gitBin?: string
  /** Optional override for `$HOME` (tests). */
  home?: string
  /** Optional override for `runGit` (tests). */
  runGit?: (args: string[], cwd: string) => { ok: boolean; stdout: string }
}

export interface PreflightResult {
  /** True if no `fail`-severity issues were produced. */
  ok: boolean
  /** All issues, in order. Filter by `severity` to separate fails from warns. */
  issues: PreflightIssue[]
}

/**
 * Run pre-flight checks for a spawn/revive. Pure: no I/O outside the
 * filesystem + `git` subprocess. Synchronous so it can run inline before
 * `Bun.spawn` without async plumbing.
 */
export function preflightSpawn(input: PreflightInput): PreflightResult {
  const issues: PreflightIssue[] = []
  const runGit = input.runGit ?? defaultRunGit

  // ─── 1. CWD existence (HARD) ──────────────────────────────────────
  if (!existsSync(input.cwd)) {
    issues.push({
      check: 'cwd_exists',
      severity: 'fail',
      message: `Working directory does not exist: ${input.cwd}. Was a worktree removed?`,
      detail: { cwd: input.cwd },
    })
    // No point running git checks if cwd is missing -- bail early.
    return { ok: false, issues }
  }

  // ─── 2. Worktree consistency (HARD) ───────────────────────────────
  if (input.worktree) {
    const wtPath = join(input.cwd, '.claude', 'worktrees', input.worktree)
    // Naming convention from scripts/worktree-create.sh: `worktree-{name}`
    const branchName = `worktree-${input.worktree}`
    const pathExists = existsSync(wtPath)
    const branchRes = runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], input.cwd)
    const branchExists = branchRes.ok

    if (!pathExists && branchExists) {
      issues.push({
        check: 'worktree_consistency',
        severity: 'fail',
        message:
          `Worktree directory removed but branch '${branchName}' still exists. ` +
          `worktree-create cannot recreate cleanly. Run \`git branch -D ${branchName}\` ` +
          `or recover the worktree with \`git worktree add\`.`,
        detail: { worktreePath: wtPath, branchName, pathExists: false, branchExists: true },
      })
    } else if (pathExists && !branchExists) {
      issues.push({
        check: 'worktree_consistency',
        severity: 'fail',
        message:
          `Worktree directory exists at ${wtPath} but branch '${branchName}' was deleted. ` +
          `Orphaned worktree. Remove it (\`git worktree remove\`) and start fresh, ` +
          `or recreate the branch.`,
        detail: { worktreePath: wtPath, branchName, pathExists: true, branchExists: false },
      })
    } else if (!pathExists && !branchExists) {
      // Fresh creation case. We don't currently auto-detect "this worktree
      // was previously finished" beyond branch+path missing -- the reflog
      // would show a deletion event but it's slow to parse. For now we
      // treat missing/missing as "OK, will be created" with no issue.
    }
    // pathExists && branchExists is the happy reuse path -- no issue.
  }

  // ─── 3. Transcript slug (SOFT) ────────────────────────────────────
  // CC writes transcripts to ~/.claude/projects/{slug}/{ccSessionId}.jsonl
  // where slug is cwd with all `/` replaced by `-`. This path layout is a
  // CC implementation detail -- they may change it. So this is a WARNING,
  // not a hard failure. If CC then dies during boot, the warning is
  // surfaced as a likely cause.
  if (input.resumeCcSessionId) {
    const home = input.home ?? process.env.HOME ?? '/root'
    const slug = input.cwd.replace(/\//g, '-')
    const expectedPath = join(home, '.claude', 'projects', slug, `${input.resumeCcSessionId}.jsonl`)
    if (!existsSync(expectedPath)) {
      // Try to locate the transcript elsewhere -- worktree-removed scenarios
      // leave the file under a different slug. This is best-effort: if we
      // find it, surface the actual path so the user (or operator) can act.
      const elsewhere = findTranscriptElsewhere(home, input.resumeCcSessionId)
      const detail: Record<string, unknown> = { expectedPath, ccSessionId: input.resumeCcSessionId }
      let message = `Transcript file not found at expected path for --resume ${input.resumeCcSessionId.slice(0, 8)}. CC may fail to resume.`
      if (elsewhere) {
        detail.foundAt = elsewhere
        message += ` Found at ${elsewhere} instead -- cwd likely changed since the original spawn (e.g. worktree was removed).`
      }
      issues.push({ check: 'transcript_slug', severity: 'warn', message, detail })
    }
  }

  const ok = issues.every(i => i.severity !== 'fail')
  return { ok, issues }
}

/**
 * Best-effort: glob ~/.claude/projects/STAR/{ccSessionId}.jsonl. Returns
 * the first match (most recently modified is not worth ranking -- the
 * file is unique per session ID). Returns null if nothing matches or the
 * projects dir doesn't exist.
 */
function findTranscriptElsewhere(home: string, ccSessionId: string): string | null {
  const projectsDir = join(home, '.claude', 'projects')
  if (!existsSync(projectsDir)) return null
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const dirs = readdirSync(projectsDir, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const candidate = join(projectsDir, d.name, `${ccSessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* ignore -- best-effort */
  }
  return null
}

/** Default git runner. Returns ok=true on exit code 0. */
function defaultRunGit(args: string[], cwd: string): { ok: boolean; stdout: string } {
  try {
    const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    return { ok: proc.exitCode === 0, stdout: proc.stdout.toString() }
  } catch {
    return { ok: false, stdout: '' }
  }
}
