import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createRulesEngine } from './permission-rules'

const testDir = join(tmpdir(), `rclaude-permission-test-${Date.now()}`)
const rclaudeDir = join(testDir, '.rclaude')

function input(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

beforeEach(() => {
  mkdirSync(rclaudeDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('project rules - Write/Edit patterns', () => {
  function engineWithRules(permissions: Record<string, { allow: string[] }>) {
    writeFileSync(join(rclaudeDir, 'rclaude.json'), JSON.stringify({ permissions }))
    return createRulesEngine(testDir)
  }

  test('matches relative path pattern', () => {
    const engine = engineWithRules({ Write: { allow: ['.claude/docs/**'] } })
    expect(engine.shouldAutoApprove('Write', input({ file_path: join(testDir, '.claude/docs/plan.md') }))).toBe(true)
  })

  test('matches nested relative path', () => {
    const engine = engineWithRules({ Write: { allow: ['.claude/docs/**'] } })
    expect(
      engine.shouldAutoApprove('Write', input({ file_path: join(testDir, '.claude/docs/deep/nested/file.md') })),
    ).toBe(true)
  })

  test('rejects non-matching path', () => {
    const engine = engineWithRules({ Write: { allow: ['.claude/docs/**'] } })
    expect(engine.shouldAutoApprove('Write', input({ file_path: join(testDir, 'src/index.ts') }))).toBe(false)
  })

  test('matches exact filename pattern', () => {
    const engine = engineWithRules({ Write: { allow: ['CHANGELOG.md'] } })
    expect(engine.shouldAutoApprove('Write', input({ file_path: join(testDir, 'CHANGELOG.md') }))).toBe(true)
  })

  test('rejects path outside CWD', () => {
    const engine = engineWithRules({ Write: { allow: ['**'] } })
    expect(engine.shouldAutoApprove('Write', input({ file_path: '/etc/passwd' }))).toBe(false)
  })

  test('rejects path traversal', () => {
    const engine = engineWithRules({ Write: { allow: ['**'] } })
    expect(engine.shouldAutoApprove('Write', input({ file_path: join(testDir, '../other/file.ts') }))).toBe(false)
  })

  test('Edit uses same rules as Write', () => {
    const engine = engineWithRules({ Edit: { allow: ['.claude/docs/**'] } })
    expect(engine.shouldAutoApprove('Edit', input({ file_path: join(testDir, '.claude/docs/plan.md') }))).toBe(true)
  })

  test('Read supported', () => {
    const engine = engineWithRules({ Read: { allow: ['.secret/**'] } })
    expect(engine.shouldAutoApprove('Read', input({ file_path: join(testDir, '.secret/keys.json') }))).toBe(true)
  })

  test('Bash not supported (CC handles it)', () => {
    const engine = engineWithRules({ Bash: { allow: ['*'] } })
    expect(engine.shouldAutoApprove('Bash', input({ command: 'ls' }))).toBe(false)
  })

  test('Glob not supported (CC handles it)', () => {
    const engine = engineWithRules({ Glob: { allow: ['**'] } })
    expect(engine.shouldAutoApprove('Glob', input({ pattern: '*.ts' }))).toBe(false)
  })
})

describe('absolute path patterns', () => {
  test('absolute pattern matches absolute file path', () => {
    writeFileSync(
      join(rclaudeDir, 'rclaude.json'),
      JSON.stringify({
        permissions: { Write: { allow: [join(testDir, 'special/**')] } },
      }),
    )
    const engine = createRulesEngine(testDir)
    expect(engine.shouldAutoApprove('Write', input({ file_path: join(testDir, 'special/file.md') }))).toBe(true)
  })

  test('absolute pattern rejects non-matching path', () => {
    writeFileSync(
      join(rclaudeDir, 'rclaude.json'),
      JSON.stringify({
        permissions: { Write: { allow: ['/opt/allowed/**'] } },
      }),
    )
    const engine = createRulesEngine(testDir)
    expect(engine.shouldAutoApprove('Write', input({ file_path: join(testDir, 'src/file.ts') }))).toBe(false)
  })
})

describe('session rules (ALWAYS ALLOW button)', () => {
  test('session rule auto-approves by tool name', () => {
    const engine = createRulesEngine(testDir)
    expect(engine.shouldAutoApprove('Write', input({ file_path: join(testDir, 'any/file.ts') }))).toBe(false)
    engine.addSessionRule('Write')
    expect(engine.shouldAutoApprove('Write', input({ file_path: join(testDir, 'any/file.ts') }))).toBe(true)
  })

  test('session rule can be removed', () => {
    const engine = createRulesEngine(testDir)
    engine.addSessionRule('Write')
    expect(engine.shouldAutoApprove('Write', input({}))).toBe(true)
    engine.removeSessionRule('Write')
    expect(engine.shouldAutoApprove('Write', input({}))).toBe(false)
  })

  test('session rules work for any tool name', () => {
    const engine = createRulesEngine(testDir)
    engine.addSessionRule('Bash')
    expect(engine.shouldAutoApprove('Bash', input({ command: 'anything' }))).toBe(true)
  })

  test('getSessionRules returns active rules', () => {
    const engine = createRulesEngine(testDir)
    engine.addSessionRule('Write')
    engine.addSessionRule('Edit')
    expect(engine.getSessionRules().sort()).toEqual(['Edit', 'Write'])
  })
})

describe('no config file', () => {
  test('works without rclaude.json', () => {
    const engine = createRulesEngine(testDir)
    expect(engine.shouldAutoApprove('Write', input({ file_path: join(testDir, 'file.ts') }))).toBe(false)
    expect(engine.getProjectRulesSummary()).toEqual({})
  })
})

describe('malformed input', () => {
  test('handles truncated JSON in inputPreview', () => {
    writeFileSync(
      join(rclaudeDir, 'rclaude.json'),
      JSON.stringify({
        permissions: { Write: { allow: ['.claude/docs/**'] } },
      }),
    )
    const engine = createRulesEngine(testDir)
    // Truncated JSON that regex can still extract file_path from
    const truncated = `{"file_path":"${join(testDir, '.claude/docs/plan.md')}","content":"long cont...`
    expect(engine.shouldAutoApprove('Write', truncated)).toBe(true)
  })

  test('handles empty inputPreview', () => {
    writeFileSync(
      join(rclaudeDir, 'rclaude.json'),
      JSON.stringify({
        permissions: { Write: { allow: ['**'] } },
      }),
    )
    const engine = createRulesEngine(testDir)
    expect(engine.shouldAutoApprove('Write', '')).toBe(false)
  })

  test('handles invalid JSON config gracefully', () => {
    writeFileSync(join(rclaudeDir, 'rclaude.json'), 'not json {{{')
    const engine = createRulesEngine(testDir)
    expect(engine.shouldAutoApprove('Write', input({ file_path: join(testDir, 'file.ts') }))).toBe(false)
  })
})

describe('isPlanModeAllowed', () => {
  test('allowed by default (no config)', () => {
    const engine = createRulesEngine(testDir)
    expect(engine.isPlanModeAllowed()).toBe(true)
  })

  test('allowed when allowPlanMode: true in rclaude.json', () => {
    writeFileSync(join(rclaudeDir, 'rclaude.json'), JSON.stringify({ allowPlanMode: true }))
    const engine = createRulesEngine(testDir)
    expect(engine.isPlanModeAllowed()).toBe(true)
  })

  test('denied when allowPlanMode: false in rclaude.json', () => {
    writeFileSync(join(rclaudeDir, 'rclaude.json'), JSON.stringify({ allowPlanMode: false }))
    const engine = createRulesEngine(testDir)
    expect(engine.isPlanModeAllowed()).toBe(false)
  })

  test('denied when RCLAUDE_NO_PLAN_MODE=1', () => {
    const engine = createRulesEngine(testDir)
    const orig = process.env.RCLAUDE_NO_PLAN_MODE
    try {
      process.env.RCLAUDE_NO_PLAN_MODE = '1'
      expect(engine.isPlanModeAllowed()).toBe(false)
    } finally {
      if (orig === undefined) delete process.env.RCLAUDE_NO_PLAN_MODE
      else process.env.RCLAUDE_NO_PLAN_MODE = orig
    }
  })

  test('env var overrides config (config true, env denies)', () => {
    writeFileSync(join(rclaudeDir, 'rclaude.json'), JSON.stringify({ allowPlanMode: true }))
    const engine = createRulesEngine(testDir)
    const orig = process.env.RCLAUDE_NO_PLAN_MODE
    try {
      process.env.RCLAUDE_NO_PLAN_MODE = '1'
      expect(engine.isPlanModeAllowed()).toBe(false)
    } finally {
      if (orig === undefined) delete process.env.RCLAUDE_NO_PLAN_MODE
      else process.env.RCLAUDE_NO_PLAN_MODE = orig
    }
  })
})

describe('getProjectRulesSummary', () => {
  test('returns loaded patterns', () => {
    writeFileSync(
      join(rclaudeDir, 'rclaude.json'),
      JSON.stringify({
        permissions: {
          Write: { allow: ['.claude/docs/**'] },
          Edit: { allow: ['CHANGELOG.md'] },
        },
      }),
    )
    const engine = createRulesEngine(testDir)
    expect(engine.getProjectRulesSummary()).toEqual({
      Write: ['.claude/docs/**'],
      Edit: ['CHANGELOG.md'],
    })
  })
})
