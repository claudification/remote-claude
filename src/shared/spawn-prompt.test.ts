import { describe, expect, it } from 'bun:test'
import {
  AUTO_COMMIT_INSTRUCTIONS,
  buildTaskPrompt,
  composeSpawnPrompt,
  type TaskMeta,
  WORKTREE_MERGEBACK_INSTRUCTIONS,
} from './spawn-prompt'

const baseTask: TaskMeta = {
  slug: 'my-task',
  title: 'Do the thing',
  status: 'open',
  priority: 'high',
  tags: ['alpha', 'beta'],
  bodyPreview: 'short preview',
  body: 'the full task body',
}

describe('composeSpawnPrompt', () => {
  it('returns base prompt unchanged when no options', () => {
    expect(composeSpawnPrompt('hello', {})).toBe('hello')
  })

  it('appends auto-commit instructions when autoCommit=true', () => {
    const out = composeSpawnPrompt('hello', { autoCommit: true })
    expect(out).toBe(`hello${AUTO_COMMIT_INSTRUCTIONS}`)
  })

  it('appends worktree merge-back instructions when worktreeMergeBack=true', () => {
    const out = composeSpawnPrompt('hello', { worktreeMergeBack: true })
    expect(out).toBe(`hello${WORKTREE_MERGEBACK_INSTRUCTIONS}`)
  })

  it('appends both suffixes when both flags are true', () => {
    const out = composeSpawnPrompt('hello', { autoCommit: true, worktreeMergeBack: true })
    expect(out).toBe(`hello${AUTO_COMMIT_INSTRUCTIONS}${WORKTREE_MERGEBACK_INSTRUCTIONS}`)
  })

  it('wraps in <project-task> when taskWrapper is provided', () => {
    const out = composeSpawnPrompt('', { taskWrapper: baseTask })
    expect(out).toContain('<project-task ')
    expect(out).toContain('id="my-task"')
    expect(out).toContain('title="Do the thing"')
    expect(out).toContain('priority="high"')
    expect(out).toContain('status="open"')
    expect(out).toContain('tags="alpha,beta"')
    expect(out).toContain('the full task body')
    expect(out).toContain('</project-task>')
  })

  it('wraps suffixes inside <project-task> when taskWrapper + lifecycle flags', () => {
    const out = composeSpawnPrompt('', {
      taskWrapper: baseTask,
      autoCommit: true,
      worktreeMergeBack: true,
    })
    expect(out).toContain('<project-task ')
    expect(out).toContain(AUTO_COMMIT_INSTRUCTIONS.trim())
    expect(out).toContain(WORKTREE_MERGEBACK_INSTRUCTIONS.trim())
    // suffixes must land before closing tag
    expect(out.indexOf('git rebase main')).toBeLessThan(out.indexOf('</project-task>'))
  })

  it('uses custom base prompt as task body when provided', () => {
    const out = composeSpawnPrompt('custom override content', { taskWrapper: baseTask })
    expect(out).toContain('custom override content')
    expect(out).not.toContain('the full task body')
  })
})

describe('buildTaskPrompt', () => {
  it('escapes quotes in title attribute', () => {
    const task: TaskMeta = { ...baseTask, title: 'Fix "quoted" bug' }
    const out = buildTaskPrompt(task)
    expect(out).toContain('title="Fix &quot;quoted&quot; bug"')
  })

  it('omits priority attr when medium (default)', () => {
    const task: TaskMeta = { ...baseTask, priority: 'medium' }
    const out = buildTaskPrompt(task)
    expect(out).not.toContain('priority=')
  })

  it('omits priority attr when missing', () => {
    const task: TaskMeta = { ...baseTask, priority: undefined }
    const out = buildTaskPrompt(task)
    expect(out).not.toContain('priority=')
  })

  it('omits tags attr when tag array is empty', () => {
    const task: TaskMeta = { ...baseTask, tags: [] }
    const out = buildTaskPrompt(task)
    expect(out).not.toContain('tags=')
  })

  it('appends extra instructions before closing tag', () => {
    const out = buildTaskPrompt(baseTask, '\n\nExtra!')
    expect(out).toContain('Extra!')
    expect(out.indexOf('Extra!')).toBeLessThan(out.indexOf('</project-task>'))
  })

  it('uses task.body when basePrompt is absent', () => {
    const out = buildTaskPrompt(baseTask)
    expect(out).toContain('the full task body')
  })

  it('falls back to bodyPreview when body is absent', () => {
    const task: TaskMeta = { ...baseTask, body: undefined }
    const out = buildTaskPrompt(task)
    expect(out).toContain('short preview')
  })

  it('falls back to title when body and bodyPreview are absent', () => {
    const task: TaskMeta = { ...baseTask, body: undefined, bodyPreview: undefined }
    const out = buildTaskPrompt(task)
    expect(out).toContain('Do the thing')
  })

  it('always includes set-status instructions with the slug', () => {
    const out = buildTaskPrompt(baseTask)
    expect(out).toContain('mcp__rclaude__project_set_status')
    expect(out).toContain('id="my-task"')
  })
})
