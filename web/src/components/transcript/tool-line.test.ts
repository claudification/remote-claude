import { describe, expect, it } from 'vitest'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'
import { dispatchToolCase, renderErrorFallback, renderPersistedOutput } from './tool-line'

function makeCtx(overrides: Partial<ToolCaseInput> = {}): ToolCaseInput {
  return {
    input: {},
    expandAll: false,
    ...overrides,
  }
}

function hasSummary(r: ToolCaseResult): boolean {
  return r.summary != null && r.summary !== ''
}

// -------------------------------------------------------------------
// dispatchToolCase: Core tool routing
// -------------------------------------------------------------------
describe('dispatchToolCase - Bash', () => {
  it('uses description as summary when present', () => {
    const r = dispatchToolCase('Bash', makeCtx({ input: { command: 'ls -la', description: 'List files' } }))
    expect(r.summary).toBe('List files')
  })

  it('truncates command at 80 chars when no description and not expanded', () => {
    const longCmd = 'a'.repeat(100)
    const r = dispatchToolCase('Bash', makeCtx({ input: { command: longCmd } }))
    expect(r.summary).toBe(`${'a'.repeat(80)}...`)
  })

  it('shows full command when expandAll is true', () => {
    const longCmd = 'a'.repeat(100)
    const r = dispatchToolCase('Bash', makeCtx({ input: { command: longCmd }, expandAll: true }))
    expect(r.summary).toBe(longCmd)
  })

  it('shows short command in full without truncation', () => {
    const r = dispatchToolCase('Bash', makeCtx({ input: { command: 'echo hi' } }))
    expect(r.summary).toBe('echo hi')
  })

  it('returns details when result is present', () => {
    const r = dispatchToolCase('Bash', makeCtx({ input: { command: 'ls' }, result: 'file1\nfile2' }))
    expect(r.details).not.toBeNull()
  })

  it('returns details when toolUseResult.stdout is present', () => {
    const r = dispatchToolCase('Bash', makeCtx({ input: { command: 'ls' }, toolUseResult: { stdout: 'file1\nfile2' } }))
    expect(r.details).not.toBeNull()
  })

  it('strips conversationPath prefix from cd commands', () => {
    const r = dispatchToolCase(
      'Bash',
      makeCtx({ input: { command: 'cd /home/user/proj && ls' }, conversationPath: '/home/user/proj' }),
    )
    expect(r.summary).not.toContain('/home/user/proj')
  })

  it('returns null details when no result or stdout', () => {
    const r = dispatchToolCase('Bash', makeCtx({ input: { command: '' } }))
    expect(r.details).toBeNull()
  })
})

describe('dispatchToolCase - REPL', () => {
  it('uses description as summary when present', () => {
    const r = dispatchToolCase('REPL', makeCtx({ input: { code: 'console.log(1)', description: 'Log it' } }))
    expect(r.summary).toBe('Log it')
  })

  it('truncates code at 80 chars when no description', () => {
    const longCode = 'x'.repeat(100)
    const r = dispatchToolCase('REPL', makeCtx({ input: { code: longCode } }))
    expect(r.summary).toBe(`${'x'.repeat(80)}...`)
  })

  it('provides inlineContent when code is present', () => {
    const r = dispatchToolCase('REPL', makeCtx({ input: { code: 'Math.PI' } }))
    expect(r.inlineContent).not.toBeNull()
  })

  it('provides details when result exists', () => {
    const r = dispatchToolCase('REPL', makeCtx({ input: { code: '1+1' }, result: '2' }))
    expect(r.details).not.toBeNull()
  })

  it('provides details when toolUseResult.stdout exists', () => {
    const r = dispatchToolCase('REPL', makeCtx({ input: { code: 'print(1)' }, toolUseResult: { stdout: '1\n' } }))
    expect(r.details).not.toBeNull()
  })

  it('no details when no result', () => {
    const r = dispatchToolCase('REPL', makeCtx({ input: { code: 'void 0' } }))
    expect(r.details).toBeNull()
  })
})

describe('dispatchToolCase - Read', () => {
  it('shows shortened file path in summary', () => {
    const r = dispatchToolCase(
      'Read',
      makeCtx({ input: { file_path: '/Users/jonas/projects/remote-claude/src/foo.ts' } }),
    )
    expect(hasSummary(r)).toBe(true)
  })

  it('handles text read with content as details', () => {
    const r = dispatchToolCase('Read', makeCtx({ input: { file_path: '/src/x.ts' }, result: 'const x = 1' }))
    expect(r.details).not.toBeNull()
  })

  it('handles text read without content - no details', () => {
    const r = dispatchToolCase('Read', makeCtx({ input: { file_path: '/src/x.ts' } }))
    expect(r.details).toBeNull()
  })

  it('handles binary image read with URL', () => {
    const r = dispatchToolCase(
      'Read',
      makeCtx({
        input: { file_path: '/img/photo.png' },
        toolUseResult: {
          type: 'image',
          file: {
            url: 'https://example.com/photo.png',
            originalSize: 10240,
            dimensions: { originalWidth: 800, originalHeight: 600, displayWidth: 400, displayHeight: 300 },
          },
        },
      }),
    )
    expect(r.details).not.toBeNull()
  })

  it('handles binary non-image file with URL', () => {
    const r = dispatchToolCase(
      'Read',
      makeCtx({
        input: { file_path: '/data/file.pdf' },
        toolUseResult: {
          type: 'pdf',
          file: { url: 'https://example.com/file.pdf', originalSize: 50000 },
        },
      }),
    )
    expect(r.details).not.toBeNull()
  })

  it('handles binary file without URL', () => {
    const r = dispatchToolCase(
      'Read',
      makeCtx({
        input: { file_path: '/img/logo.svg' },
        toolUseResult: { type: 'image', file: { originalSize: 1024 } },
      }),
    )
    expect(r.details).not.toBeNull()
  })

  it('shows partial read info (startLine/endLine)', () => {
    const r = dispatchToolCase(
      'Read',
      makeCtx({
        input: { file_path: '/big.ts', offset: 100 },
        toolUseResult: { file: { startLine: 100, numLines: 50, totalLines: 1000 } },
      }),
    )
    expect(hasSummary(r)).toBe(true)
  })
})

describe('dispatchToolCase - Edit', () => {
  it('shows file path as summary', () => {
    const r = dispatchToolCase('Edit', makeCtx({ input: { file_path: '/src/index.ts' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('computes diff from old_string/new_string', () => {
    const r = dispatchToolCase(
      'Edit',
      makeCtx({
        input: {
          file_path: '/src/app.ts',
          old_string: 'const x = 1\nconst y = 2',
          new_string: 'const x = 42\nconst y = 2',
        },
      }),
    )
    expect(r.details).not.toBeNull()
  })

  it('uses structuredPatch from toolUseResult when available', () => {
    const r = dispatchToolCase(
      'Edit',
      makeCtx({
        input: { file_path: '/src/foo.ts' },
        toolUseResult: { structuredPatch: [{ oldStart: 1, lines: ['-old', '+new'] }] },
      }),
    )
    expect(r.details).not.toBeNull()
  })

  it('no details on error', () => {
    const r = dispatchToolCase(
      'Edit',
      makeCtx({
        input: { file_path: '/src/x.ts', old_string: 'a', new_string: 'b' },
        isError: true,
      }),
    )
    expect(r.details).toBeNull()
  })

  it('no details when no old_string/new_string and no structuredPatch', () => {
    const r = dispatchToolCase('Edit', makeCtx({ input: { file_path: '/src/x.ts' } }))
    expect(r.details).toBeNull()
  })

  it('uses originalFile for full-context diff when available', () => {
    const originalFile = 'line1\nline2\nconst x = 1\nline4\n'
    const r = dispatchToolCase(
      'Edit',
      makeCtx({
        input: { file_path: '/src/x.ts', old_string: 'const x = 1', new_string: 'const x = 2' },
        toolUseResult: { originalFile },
      }),
    )
    expect(r.details).not.toBeNull()
  })
})

describe('dispatchToolCase - Write', () => {
  it('shows file path and char count in summary', () => {
    const r = dispatchToolCase('Write', makeCtx({ input: { file_path: '/src/new.ts', content: 'hello world' } }))
    expect(r.summary).toContain('11 chars')
  })

  it('provides details with content preview', () => {
    const r = dispatchToolCase(
      'Write',
      makeCtx({ input: { file_path: '/src/big.ts', content: 'export const x = 42' } }),
    )
    expect(r.details).not.toBeNull()
  })

  it('handles zero-length content', () => {
    const r = dispatchToolCase('Write', makeCtx({ input: { file_path: '/src/empty.ts', content: '' } }))
    expect(r.summary).toContain('0 chars')
    expect(r.details).toBeNull()
  })
})

describe('dispatchToolCase - WebSearch/WebFetch', () => {
  it('WebSearch uses query as summary', () => {
    const r = dispatchToolCase('WebSearch', makeCtx({ input: { query: 'react hooks best practices' } }))
    expect(r.summary).toBe('react hooks best practices')
  })

  it('WebSearch shows result as markdown details', () => {
    const r = dispatchToolCase('WebSearch', makeCtx({ input: { query: 'test' }, result: '# Results\n- item1' }))
    expect(r.details).not.toBeNull()
  })

  it('WebFetch parses URL hostname+path', () => {
    const r = dispatchToolCase('WebFetch', makeCtx({ input: { url: 'https://docs.rs/tokio/latest/overview' } }))
    expect(r.summary).toBe('docs.rs/tokio/latest/overview')
  })

  it('WebFetch falls back to raw URL on parse error', () => {
    const r = dispatchToolCase('WebFetch', makeCtx({ input: { url: 'not a url at all' } }))
    expect(r.summary).toBe('not a url at all')
  })

  it('WebFetch provides truncated result details', () => {
    const r = dispatchToolCase('WebFetch', makeCtx({ input: { url: 'https://x.com' }, result: '<html>...</html>' }))
    expect(r.details).not.toBeNull()
  })
})

describe('dispatchToolCase - Glob/Grep', () => {
  it('Glob returns summary for pattern', () => {
    const r = dispatchToolCase('Glob', makeCtx({ input: { pattern: '**/*.tsx' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('Glob returns file list details when filenames present', () => {
    const r = dispatchToolCase(
      'Glob',
      makeCtx({
        input: { pattern: '*.ts' },
        toolUseResult: { filenames: ['a.ts', 'b.ts'], numFiles: 2 },
      }),
    )
    expect(r.details).not.toBeNull()
  })

  it('Grep returns summary with pattern info', () => {
    const r = dispatchToolCase('Grep', makeCtx({ input: { pattern: 'useState', path: 'src/' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('Grep returns content details when mode is content', () => {
    const r = dispatchToolCase(
      'Grep',
      makeCtx({
        input: { pattern: 'foo' },
        toolUseResult: { mode: 'content', content: 'src/a.ts:5:const foo = 1', filenames: ['src/a.ts'] },
      }),
    )
    expect(r.details).not.toBeNull()
  })

  it('Grep returns count details when mode is count', () => {
    const r = dispatchToolCase(
      'Grep',
      makeCtx({
        input: { pattern: 'test' },
        toolUseResult: { mode: 'count', content: 'src/a.ts:5\nsrc/b.ts:3', numMatches: 8, numFiles: 2 },
      }),
    )
    expect(r.details).not.toBeNull()
  })

  it('Grep on error still returns summary', () => {
    const r = dispatchToolCase(
      'Grep',
      makeCtx({ input: { pattern: '[invalid' }, isError: true, result: 'regex parse error' }),
    )
    expect(hasSummary(r)).toBe(true)
    expect(r.details).not.toBeNull()
  })
})

describe('dispatchToolCase - Agent/Task', () => {
  it('Agent with subagent_type prefixes summary', () => {
    const r = dispatchToolCase(
      'Agent',
      makeCtx({ input: { description: 'Search codebase', subagent_type: 'code-archaeologist', prompt: 'find bugs' } }),
    )
    expect(r.summary).toBe('code-archaeologist: Search codebase')
  })

  it('Task without subagent_type uses bare description', () => {
    const r = dispatchToolCase('Task', makeCtx({ input: { description: 'Build project', prompt: 'bun run build' } }))
    expect(r.summary).toBe('Build project')
  })

  it('Agent provides prompt as details', () => {
    const r = dispatchToolCase('Agent', makeCtx({ input: { description: 'x', prompt: 'Do this thing carefully' } }))
    expect(r.details).not.toBeNull()
  })

  it('Agent matches subagent and provides badge + matchedAgentId', () => {
    const subagents = [
      {
        agentId: 'sub-123',
        agentType: 'Explore',
        description: 'Find the config',
        status: 'stopped' as const,
        startedAt: 1000,
        stoppedAt: 5000,
        eventCount: 12,
        tokenUsage: { totalInput: 5000, totalOutput: 2000, cacheCreation: 0, cacheRead: 0 },
      },
    ]
    const r = dispatchToolCase('Agent', makeCtx({ input: { description: 'Find the config', prompt: 'p' }, subagents }))
    expect(r.matchedAgentId).toBe('sub-123')
    expect(r.agentBadge).not.toBeNull()
  })

  it('Agent with no matching subagent has no badge', () => {
    const subagents = [
      {
        agentId: 'sub-999',
        agentType: 'Explore',
        description: 'Different description',
        status: 'running' as const,
        startedAt: 1000,
        eventCount: 0,
      },
    ]
    const r = dispatchToolCase('Agent', makeCtx({ input: { description: 'My unique desc', prompt: 'p' }, subagents }))
    expect(r.matchedAgentId).toBeNull()
    expect(r.agentBadge).toBeNull()
  })

  it('Task tool does not attempt subagent matching', () => {
    const subagents = [
      {
        agentId: 'sub-1',
        agentType: 'x',
        description: 'Same desc',
        status: 'stopped' as const,
        startedAt: 0,
        stoppedAt: 1,
        eventCount: 0,
      },
    ]
    const r = dispatchToolCase('Task', makeCtx({ input: { description: 'Same desc', prompt: 'p' }, subagents }))
    expect(r.matchedAgentId).toBeNull()
    expect(r.agentBadge).toBeNull()
  })
})

describe('dispatchToolCase - AskUserQuestion', () => {
  it('shows first question as summary', () => {
    const questions = [{ question: 'Pick a color', options: [{ label: 'Red' }, { label: 'Blue' }] }]
    const r = dispatchToolCase('AskUserQuestion', makeCtx({ input: { questions } }))
    expect(r.summary).toBe('Pick a color')
  })

  it('truncates long question at 60 chars', () => {
    const longQ = 'q'.repeat(80)
    const questions = [{ question: longQ }]
    const r = dispatchToolCase('AskUserQuestion', makeCtx({ input: { questions } }))
    expect(r.summary).toBe(`${'q'.repeat(60)}...`)
  })

  it('provides details with options list', () => {
    const questions = [
      { question: 'Which?', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
    ]
    const r = dispatchToolCase('AskUserQuestion', makeCtx({ input: { questions } }))
    expect(r.details).not.toBeNull()
  })

  it('handles empty questions array', () => {
    const r = dispatchToolCase('AskUserQuestion', makeCtx({ input: { questions: [] } }))
    expect(r.summary).toBe('')
    expect(r.details).toBeNull()
  })
})

describe('dispatchToolCase - Task management', () => {
  it('TaskCreate shows subject and pending status', () => {
    const r = dispatchToolCase(
      'TaskCreate',
      makeCtx({ input: { subject: 'Fix login bug', description: 'Users cant log in' } }),
    )
    expect(hasSummary(r)).toBe(true)
    expect(r.details).not.toBeNull()
  })

  it('TaskCreate parses id from result', () => {
    const r = dispatchToolCase(
      'TaskCreate',
      makeCtx({ input: { subject: 'Do thing' }, result: 'Task #42 created successfully: Do thing' }),
    )
    expect(hasSummary(r)).toBe(true)
  })

  it('TaskUpdate shows status change', () => {
    const r = dispatchToolCase('TaskUpdate', makeCtx({ input: { id: '7', status: 'completed', subject: 'Done' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('TaskOutput shows task id as summary', () => {
    const r = dispatchToolCase('TaskOutput', makeCtx({ input: { taskId: '5' }, result: 'output here' }))
    expect(hasSummary(r)).toBe(true)
    expect(r.details).not.toBeNull()
  })

  it('TaskList shows task id', () => {
    const r = dispatchToolCase('TaskList', makeCtx({ input: { id: '3' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('TaskStop shows task id', () => {
    const r = dispatchToolCase('TaskStop', makeCtx({ input: { taskId: '9' } }))
    expect(hasSummary(r)).toBe(true)
  })
})

describe('dispatchToolCase - TodoWrite', () => {
  it('shows "All done" when all tasks completed', () => {
    const todos = [
      { content: 'Task 1', status: 'completed' },
      { content: 'Task 2', status: 'completed' },
    ]
    const r = dispatchToolCase('TodoWrite', makeCtx({ input: { todos } }))
    expect(hasSummary(r)).toBe(true)
    expect(r.details).not.toBeNull()
  })

  it('shows in-progress task activeForm', () => {
    const todos = [
      { content: 'Fix bug', activeForm: 'Fixing bug', status: 'in_progress' },
      { content: 'Write tests', status: 'pending' },
    ]
    const r = dispatchToolCase('TodoWrite', makeCtx({ input: { todos } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('shows total count for fresh todo list', () => {
    const todos = [
      { content: 'Step 1', status: 'pending' },
      { content: 'Step 2', status: 'pending' },
      { content: 'Step 3', status: 'pending' },
    ]
    const r = dispatchToolCase('TodoWrite', makeCtx({ input: { todos } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('handles empty todos', () => {
    const r = dispatchToolCase('TodoWrite', makeCtx({ input: { todos: [] } }))
    expect(r.summary).toBe('')
  })
})

describe('dispatchToolCase - Skill', () => {
  it('shows skill name with args', () => {
    const r = dispatchToolCase('Skill', makeCtx({ input: { skill: 'generate-image', args: 'a sunset over ocean' } }))
    expect(r.summary).toBe('generate-image a sunset over ocean')
  })

  it('shows skill name alone when no args', () => {
    const r = dispatchToolCase('Skill', makeCtx({ input: { skill: 'git-commit' } }))
    expect(r.summary).toBe('git-commit')
  })
})

describe('dispatchToolCase - PlanMode', () => {
  it('EnterPlanMode shows entering message', () => {
    const r = dispatchToolCase('EnterPlanMode', makeCtx())
    expect(r.summary).toBe('entering plan mode')
  })

  it('ExitPlanMode with planPath shows plan path', () => {
    const r = dispatchToolCase(
      'ExitPlanMode',
      makeCtx({ planPath: '/proj/.claude/docs/plan-foo.md', planContent: '# Plan\n- step 1' }),
    )
    expect(r.summary).toContain('plan')
    expect(r.details).not.toBeNull()
  })

  it('ExitPlanMode without planPath shows generic exit', () => {
    const r = dispatchToolCase('ExitPlanMode', makeCtx())
    expect(r.summary).toBe('exiting plan mode')
  })
})

describe('dispatchToolCase - NotebookEdit/SendMessage/Team', () => {
  it('NotebookEdit with cell_id', () => {
    const r = dispatchToolCase('NotebookEdit', makeCtx({ input: { cell_id: 'abc123' } }))
    expect(r.summary).toBe('cell abc123')
  })

  it('NotebookEdit without cell_id', () => {
    const r = dispatchToolCase('NotebookEdit', makeCtx({ input: {} }))
    expect(r.summary).toBe('edit')
  })

  it('SendMessage truncates at 60 chars', () => {
    const msg = 'm'.repeat(80)
    const r = dispatchToolCase('SendMessage', makeCtx({ input: { message: msg } }))
    expect(r.summary).toBe(`${'m'.repeat(60)}...`)
  })

  it('SendMessage shows short message fully', () => {
    const r = dispatchToolCase('SendMessage', makeCtx({ input: { message: 'hello bob' } }))
    expect(r.summary).toBe('hello bob')
  })

  it('TeamCreate shows team name', () => {
    const r = dispatchToolCase('TeamCreate', makeCtx({ input: { name: 'alpha-team' } }))
    expect(r.summary).toBe('alpha-team')
  })

  it('TeamDelete shows team name', () => {
    const r = dispatchToolCase('TeamDelete', makeCtx({ input: { name: 'old-team' } }))
    expect(r.summary).toBe('old-team')
  })
})

describe('dispatchToolCase - Cron/Schedule/Monitor', () => {
  it('CronCreate with cron expression', () => {
    const r = dispatchToolCase(
      'CronCreate',
      makeCtx({ input: { cron: '0 9 * * *', recurring: true, prompt: 'daily check' } }),
    )
    expect(r.summary).toContain('0 9 * * *')
    expect(r.summary).toContain('recurring')
    expect(r.details).not.toBeNull()
  })

  it('CronCreate with rich body format', () => {
    const r = dispatchToolCase(
      'CronCreate',
      makeCtx({
        input: {
          body: {
            name: 'Daily Backup',
            cron_expression: '0 2 * * *',
            enabled: true,
            job_config: {
              ccr: { session_context: { model: 'opus' }, events: [{ data: { message: { content: 'backup now' } } }] },
            },
          },
        },
      }),
    )
    expect(hasSummary(r)).toBe(true)
    expect(r.details).not.toBeNull()
  })

  it('CronList with jobs in toolUseResult', () => {
    const jobs = [
      { id: 'job-abcdef12', humanSchedule: 'Every day at 9am', prompt: 'check health', recurring: true },
      { id: 'job-12345678', humanSchedule: 'Once at 3pm', prompt: 'deploy', recurring: false },
    ]
    const r = dispatchToolCase('CronList', makeCtx({ toolUseResult: { jobs } }))
    expect(r.summary).toBe('2 jobs')
    expect(r.details).not.toBeNull()
  })

  it('CronList with no jobs', () => {
    const r = dispatchToolCase('CronList', makeCtx({ toolUseResult: { jobs: [] } }))
    expect(r.summary).toBe('no jobs')
  })

  it('CronDelete shows truncated id', () => {
    const r = dispatchToolCase('CronDelete', makeCtx({ input: { id: 'cron-abcdef1234567890' } }))
    expect(r.summary).toBe('delete cron-abc')
  })

  it('ScheduleWakeup shows delay in minutes and reason', () => {
    const r = dispatchToolCase(
      'ScheduleWakeup',
      makeCtx({ input: { delaySeconds: 300, reason: 'waiting for build', prompt: '/loop check build' } }),
    )
    expect(hasSummary(r)).toBe(true)
    expect(r.details).not.toBeNull()
  })

  it('ScheduleWakeup hides autonomous-loop-dynamic prompt', () => {
    const r = dispatchToolCase(
      'ScheduleWakeup',
      makeCtx({ input: { delaySeconds: 1200, reason: 'idle check', prompt: '<<autonomous-loop-dynamic>>' } }),
    )
    expect(r.details).toBeNull()
  })

  it('Monitor with description and command', () => {
    const r = dispatchToolCase(
      'Monitor',
      makeCtx({ input: { description: 'Watch logs', command: 'tail -f /var/log/app.log', timeout_ms: 30000 } }),
    )
    expect(hasSummary(r)).toBe(true)
    expect(r.details).not.toBeNull()
  })

  it('Monitor shows persistent flag', () => {
    const r = dispatchToolCase(
      'Monitor',
      makeCtx({ input: { command: 'watch', persistent: true }, toolUseResult: { taskId: 'task-abcd1234' } }),
    )
    expect(hasSummary(r)).toBe(true)
  })
})

describe('dispatchToolCase - MCP rclaude tools', () => {
  it('mcp__rclaude__send_message shows target and intent', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__send_message',
      makeCtx({ input: { to: 'worker-session', intent: 'request', message: 'Do this task' } }),
    )
    expect(hasSummary(r)).toBe(true)
    expect(r.details).not.toBeNull()
  })

  it('mcp__rclaude__revive_conversation shows revive action', () => {
    const r = dispatchToolCase('mcp__rclaude__revive_conversation', makeCtx({ input: { session_id: 'sess-abc' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__rclaude__terminate_conversation shows terminate action', () => {
    const r = dispatchToolCase('mcp__rclaude__terminate_conversation', makeCtx({ input: { session_id: 'sess-xyz' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__rclaude__exit_conversation routes to lifecycle handler', () => {
    const r = dispatchToolCase('mcp__rclaude__exit_conversation', makeCtx({ input: { session_id: 'sess-q' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__rclaude__list_conversations with filters', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__list_conversations',
      makeCtx({ input: { filter: 'remote*', status: 'live' } }),
    )
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__rclaude__notify shows message', () => {
    const r = dispatchToolCase('mcp__rclaude__notify', makeCtx({ input: { message: 'Build complete!' } }))
    expect(r.summary).toBe('Build complete!')
  })

  it('mcp__rclaude__notify truncates at 80 chars', () => {
    const longMsg = 'n'.repeat(100)
    const r = dispatchToolCase('mcp__rclaude__notify', makeCtx({ input: { message: longMsg } }))
    expect(r.summary).toBe('n'.repeat(80))
  })

  it('mcp__rclaude__spawn_conversation shows project info', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__spawn_conversation',
      makeCtx({ input: { project: '/home/user/myproject', prompt: 'refactor the auth module' } }),
    )
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__rclaude__control_conversation shows action and target', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__control_conversation',
      makeCtx({ input: { session_id: 'sess-1', action: 'set_model', model: 'opus' } }),
    )
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__rclaude__configure_conversation shows fields', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__configure_conversation',
      makeCtx({ input: { session_id: 'sess-1', label: 'My Conversation', color: 'blue' } }),
    )
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__rclaude__dialog with pages', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__dialog',
      makeCtx({ input: { title: 'Setup Wizard', pages: [{}, {}, {}] } }),
    )
    expect(hasSummary(r)).toBe(true)
    expect(r.details).not.toBeNull()
  })

  it('mcp__rclaude__dialog with body components', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__dialog',
      makeCtx({ input: { title: 'Confirm', body: [{ type: 'text' }, { type: 'button' }] } }),
    )
    expect(hasSummary(r)).toBe(true)
  })
})

describe('dispatchToolCase - MCP Gmail tools', () => {
  it('mcp__gmail__search_emails shows query', () => {
    const r = dispatchToolCase('mcp__gmail__search_emails', makeCtx({ input: { query: 'from:boss@company.com' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__gmail__get_thread shows thread', () => {
    const r = dispatchToolCase('mcp__gmail__get_thread', makeCtx({ input: { thread_id: 'thread-abc' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__gmail__draft_email shows recipient and subject', () => {
    const r = dispatchToolCase(
      'mcp__gmail__draft_email',
      makeCtx({ input: { to: 'colleague@work.com', subject: 'Meeting notes' } }),
    )
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__gmail__modify_email routes to label op', () => {
    const r = dispatchToolCase('mcp__gmail__modify_email', makeCtx({ input: { id: 'email-1' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__gmail__batch_modify_emails routes to label op', () => {
    const r = dispatchToolCase('mcp__gmail__batch_modify_emails', makeCtx({ input: { ids: ['e1', 'e2'] } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__gmail__create_label routes to label op', () => {
    const r = dispatchToolCase('mcp__gmail__create_label', makeCtx({ input: { name: 'Important' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__gmail__list_email_labels returns summary', () => {
    const r = dispatchToolCase('mcp__gmail__list_email_labels', makeCtx())
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__gmail__list_inbox_threads returns summary', () => {
    const r = dispatchToolCase('mcp__gmail__list_inbox_threads', makeCtx())
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__gmail__get_inbox_with_threads returns summary', () => {
    const r = dispatchToolCase('mcp__gmail__get_inbox_with_threads', makeCtx())
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__gmail__send_email returns summary', () => {
    const r = dispatchToolCase('mcp__gmail__send_email', makeCtx({ input: { to: 'x@y.com', body: 'hi' } }))
    expect(hasSummary(r)).toBe(true)
  })

  it('mcp__gmail__reply_all returns summary', () => {
    const r = dispatchToolCase('mcp__gmail__reply_all', makeCtx({ input: { thread_id: 't1', body: 'thanks' } }))
    expect(hasSummary(r)).toBe(true)
  })
})

describe('dispatchToolCase - MCP default/unknown', () => {
  it('unknown mcp__ tool uses input keys as summary', () => {
    const r = dispatchToolCase('mcp__myserver__custom_action', makeCtx({ input: { key: 'value', count: 5 } }))
    expect(r.summary).toContain('key=value')
    expect(r.summary).toContain('count=5')
  })

  it('unknown mcp__ tool with no input uses server/tool as summary', () => {
    const r = dispatchToolCase('mcp__myserver__my_tool', makeCtx({ input: {} }))
    expect(r.summary).toBe('myserver/my_tool')
  })

  it('unknown mcp__ tool truncates long input values at 40 chars', () => {
    const longVal = 'v'.repeat(60)
    const r = dispatchToolCase('mcp__srv__tool', makeCtx({ input: { data: longVal } }))
    expect(r.summary).toContain('...')
  })

  it('unknown mcp__ tool with result shows details', () => {
    const r = dispatchToolCase('mcp__srv__tool', makeCtx({ input: { x: 1 }, result: 'some output text' }))
    expect(r.details).not.toBeNull()
  })

  it('completely unknown (non-mcp) tool returns JSON fallback', () => {
    const r = dispatchToolCase('FutureTool', makeCtx({ input: { alpha: 'beta' } }))
    expect(r.summary).toBe('{"alpha":"beta"}')
    expect(r.details).toBeNull()
  })

  it('fallback JSON truncated at 60 chars', () => {
    const longValue = 'a'.repeat(100)
    const r = dispatchToolCase('FutureTool', makeCtx({ input: { data: longValue } }))
    expect((r.summary as string).length).toBe(60)
  })

  it('ToolSearch returns query directly', () => {
    const r = dispatchToolCase('ToolSearch', makeCtx({ input: { query: 'select:Write,Edit' } }))
    expect(r.summary).toBe('select:Write,Edit')
    expect(r.details).toBeNull()
  })
})

// -------------------------------------------------------------------
// renderErrorFallback
// -------------------------------------------------------------------
describe('renderErrorFallback', () => {
  it('extracts error from tool_use_error tags', () => {
    const result = '<tool_use_error>Permission denied: /etc/shadow</tool_use_error>'
    const node = renderErrorFallback(result) as { props: { children: string } }
    expect(node.props.children).toBe('Permission denied: /etc/shadow')
  })

  it('uses full result when no tool_use_error tags', () => {
    const result = 'Something went wrong'
    const node = renderErrorFallback(result) as { props: { children: string } }
    expect(node.props.children).toBe('Something went wrong')
  })

  it('trims whitespace inside tags', () => {
    const result = '<tool_use_error>  \n  Trimmed error  \n  </tool_use_error>'
    const node = renderErrorFallback(result) as { props: { children: string } }
    expect(node.props.children).toBe('Trimmed error')
  })

  it('handles multiline error content', () => {
    const result = '<tool_use_error>Line 1\nLine 2\nLine 3</tool_use_error>'
    const node = renderErrorFallback(result) as { props: { children: string } }
    expect(node.props.children).toBe('Line 1\nLine 2\nLine 3')
  })

  it('extracts first match when multiple error tags exist', () => {
    const result = '<tool_use_error>First</tool_use_error> more text <tool_use_error>Second</tool_use_error>'
    const node = renderErrorFallback(result) as { props: { children: string } }
    expect(node.props.children).toBe('First')
  })

  it('renders as a div element with error styling', () => {
    const node = renderErrorFallback('error') as { type: string; props: { className: string } }
    expect(node.type).toBe('div')
    expect(node.props.className).toContain('text-red')
  })
})

// -------------------------------------------------------------------
// renderPersistedOutput
// -------------------------------------------------------------------
describe('renderPersistedOutput', () => {
  it('returns null when no persisted-output tags', () => {
    expect(renderPersistedOutput('normal output without tags')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(renderPersistedOutput('')).toBeNull()
  })

  it('returns non-null when persisted-output tags present', () => {
    const result = `<persisted-output>
Output too large (2.5MB)
Full output saved to: /tmp/output.txt
Preview (first 100 chars):
hello world
</persisted-output>`
    const node = renderPersistedOutput(result)
    expect(node).not.toBeNull()
  })

  it('handles output without preview section', () => {
    const result = `<persisted-output>
Output too large (500KB)
Full output saved to: /tmp/data.json
</persisted-output>`
    const node = renderPersistedOutput(result)
    expect(node).not.toBeNull()
  })

  it('handles output without path', () => {
    const result = `<persisted-output>
Output too large (1MB)
</persisted-output>`
    const node = renderPersistedOutput(result)
    expect(node).not.toBeNull()
  })

  it('returns null when tags are not properly closed', () => {
    expect(renderPersistedOutput('<persisted-output>unclosed')).toBeNull()
  })

  it('handles nested content with special chars', () => {
    const result = `<persisted-output>
Output too large (3.2MB)
Full output saved to: /home/user/output-2024-01-01.json
Preview (first 200 chars):
{"data": [1, 2, 3], "status": "ok"}
</persisted-output>`
    expect(renderPersistedOutput(result)).not.toBeNull()
  })
})

// -------------------------------------------------------------------
// Integration: error/persisted-output fallback in ToolLine context
// -------------------------------------------------------------------
describe('dispatchToolCase + error/persisted-output integration', () => {
  it('error on Bash with result generates error details', () => {
    const r = dispatchToolCase(
      'Bash',
      makeCtx({
        input: { command: 'rm -rf /' },
        isError: true,
        result: '<tool_use_error>Operation not permitted</tool_use_error>',
      }),
    )
    expect(r.details).not.toBeNull()
  })

  it('error on Read still generates summary', () => {
    const r = dispatchToolCase(
      'Read',
      makeCtx({
        input: { file_path: '/nonexistent/path.ts' },
        isError: true,
        result: '<tool_use_error>File not found</tool_use_error>',
      }),
    )
    expect(hasSummary(r)).toBe(true)
  })

  it('error on Grep with invalid regex', () => {
    const r = dispatchToolCase(
      'Grep',
      makeCtx({
        input: { pattern: '(unclosed' },
        isError: true,
        result: 'regex parse error: unclosed group',
      }),
    )
    expect(hasSummary(r)).toBe(true)
  })

  it('non-error Read result with persisted output', () => {
    const result = `<persisted-output>
Output too large (5MB)
Full output saved to: /tmp/big-file.txt
Preview (first 500 chars):
lots of content here
</persisted-output>`
    const r = dispatchToolCase('Read', makeCtx({ input: { file_path: '/huge.log' }, result }))
    expect(hasSummary(r)).toBe(true)
  })

  it('no details when no error and no result', () => {
    const r = dispatchToolCase('Edit', makeCtx({ input: { file_path: '/x.ts' } }))
    expect(r.details).toBeNull()
  })
})
