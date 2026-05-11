import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflightSpawn } from './preflight'

function tmp(prefix = 'preflight-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function gitOk(_args: string[]) {
  return { ok: true, stdout: '' }
}
function gitFail(_args: string[]) {
  return { ok: false, stdout: '' }
}

describe('preflightSpawn', () => {
  describe('cwd_exists (hard)', () => {
    test('passes when cwd exists', () => {
      const cwd = tmp()
      const r = preflightSpawn({ cwd, runGit: gitOk })
      expect(r.ok).toBe(true)
      expect(r.issues).toHaveLength(0)
    })

    test('fails when cwd missing and skips remaining checks', () => {
      const r = preflightSpawn({
        cwd: '/nonexistent/path/abc123',
        worktree: 'feat/x',
        resumeCcSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        runGit: gitOk,
      })
      expect(r.ok).toBe(false)
      expect(r.issues).toHaveLength(1)
      expect(r.issues[0].check).toBe('cwd_exists')
      expect(r.issues[0].severity).toBe('fail')
    })
  })

  describe('worktree_consistency (hard)', () => {
    test('passes when path + branch both missing (fresh creation)', () => {
      const cwd = tmp()
      const r = preflightSpawn({ cwd, worktree: 'feat/new', runGit: gitFail })
      expect(r.ok).toBe(true)
      expect(r.issues.filter(i => i.check === 'worktree_consistency')).toHaveLength(0)
    })

    test('passes when path + branch both exist (happy reuse)', () => {
      const cwd = tmp()
      mkdirSync(join(cwd, '.claude/worktrees/feat/x'), { recursive: true })
      const r = preflightSpawn({ cwd, worktree: 'feat/x', runGit: gitOk })
      expect(r.ok).toBe(true)
      expect(r.issues.filter(i => i.check === 'worktree_consistency')).toHaveLength(0)
    })

    test('fails when path missing but branch exists (the bug from May 2026)', () => {
      const cwd = tmp()
      const r = preflightSpawn({ cwd, worktree: 'feat/launch-profiles', runGit: gitOk })
      expect(r.ok).toBe(false)
      const issue = r.issues.find(i => i.check === 'worktree_consistency')
      expect(issue?.severity).toBe('fail')
      expect(issue?.message).toContain('still exists')
      expect(issue?.message).toContain('worktree-feat/launch-profiles')
      expect(issue?.detail).toMatchObject({ pathExists: false, branchExists: true })
    })

    test('fails when path exists but branch missing (orphaned worktree)', () => {
      const cwd = tmp()
      mkdirSync(join(cwd, '.claude/worktrees/feat/orphan'), { recursive: true })
      const r = preflightSpawn({ cwd, worktree: 'feat/orphan', runGit: gitFail })
      expect(r.ok).toBe(false)
      const issue = r.issues.find(i => i.check === 'worktree_consistency')
      expect(issue?.severity).toBe('fail')
      expect(issue?.message).toContain('branch')
      expect(issue?.detail).toMatchObject({ pathExists: true, branchExists: false })
    })

    test('skipped when worktree not requested', () => {
      const cwd = tmp()
      const r = preflightSpawn({ cwd, runGit: gitOk })
      expect(r.issues.filter(i => i.check === 'worktree_consistency')).toHaveLength(0)
    })
  })

  describe('transcript_slug (soft)', () => {
    test('warns (does not fail) when transcript missing at expected slug', () => {
      const cwd = tmp()
      const home = tmp('preflight-home-')
      const r = preflightSpawn({
        cwd,
        resumeCcSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        home,
        runGit: gitOk,
      })
      expect(r.ok).toBe(true)
      const issue = r.issues.find(i => i.check === 'transcript_slug')
      expect(issue?.severity).toBe('warn')
      expect(issue?.message).toContain('not found at expected path')
    })

    test('silent when transcript exists at expected slug', () => {
      const cwd = tmp()
      const home = tmp('preflight-home-')
      const ccSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const slug = cwd.replace(/\//g, '-')
      const dir = join(home, '.claude', 'projects', slug)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${ccSessionId}.jsonl`), '{}\n')
      const r = preflightSpawn({ cwd, resumeCcSessionId: ccSessionId, home, runGit: gitOk })
      expect(r.ok).toBe(true)
      expect(r.issues.filter(i => i.check === 'transcript_slug')).toHaveLength(0)
    })

    test('locates transcript at a different slug and reports it (worktree-removed scenario)', () => {
      const cwd = tmp() // current cwd: the main repo
      const home = tmp('preflight-home-')
      const ccSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      // Plant the transcript under a DIFFERENT slug (where the worktree used to be).
      const wrongSlug = `${cwd.replace(/\//g, '-')}--claude-worktrees-feat-launch-profiles`
      const wrongDir = join(home, '.claude', 'projects', wrongSlug)
      mkdirSync(wrongDir, { recursive: true })
      const wrongPath = join(wrongDir, `${ccSessionId}.jsonl`)
      writeFileSync(wrongPath, '{}\n')

      const r = preflightSpawn({ cwd, resumeCcSessionId: ccSessionId, home, runGit: gitOk })
      expect(r.ok).toBe(true)
      const issue = r.issues.find(i => i.check === 'transcript_slug')
      expect(issue?.severity).toBe('warn')
      expect(issue?.message).toContain('Found at')
      expect(issue?.message).toContain('worktree was removed')
      expect(issue?.detail).toMatchObject({ foundAt: wrongPath })
    })

    test('skipped when no resume id', () => {
      const cwd = tmp()
      const r = preflightSpawn({ cwd, runGit: gitOk })
      expect(r.issues.filter(i => i.check === 'transcript_slug')).toHaveLength(0)
    })
  })

  test('the May 2026 worktree-cleanup scenario surfaces a clear, actionable failure', () => {
    // Reproduce the bug: worktree dir was removed (worktree-finish cleanup),
    // local branch was also deleted, but stored spawn args still reference
    // --worktree feat/launch-profiles. Pre-flight should pass (matches the
    // "fresh creation" case) but the soft transcript check should flag the
    // mismatch so early CC failure is explainable.
    const cwd = tmp()
    const home = tmp('preflight-home-')
    const ccSessionId = '4abb5fdd-695d-4fb0-b303-aa8b399c75f4'
    const wrongSlug = `${cwd.replace(/\//g, '-')}--claude-worktrees-feat-launch-profiles`
    const wrongDir = join(home, '.claude', 'projects', wrongSlug)
    mkdirSync(wrongDir, { recursive: true })
    writeFileSync(join(wrongDir, `${ccSessionId}.jsonl`), '{}\n')

    const r = preflightSpawn({
      cwd,
      worktree: 'feat/launch-profiles',
      resumeCcSessionId: ccSessionId,
      home,
      runGit: gitFail, // both branch and worktree dir gone
    })
    expect(r.ok).toBe(true) // soft -- spawn proceeds
    const transcript = r.issues.find(i => i.check === 'transcript_slug')
    expect(transcript?.severity).toBe('warn')
    expect(transcript?.message).toMatch(/worktree was removed/)
  })
})
