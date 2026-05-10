import { describe, expect, test } from 'vitest'
import { canonicalizeToolUse, ensureCanonical } from './legacy-to-canonical'
import type { TranscriptContentBlock } from './types'

describe('canonicalizeToolUse -- Claude legacy (PascalCase + snake_case)', () => {
  test('Read', () => {
    expect(canonicalizeToolUse('Read', { file_path: '/etc/hosts', limit: 5 })).toEqual({
      kind: 'file.read',
      canonicalInput: { path: '/etc/hosts', limit: 5 },
    })
  })

  test('Write', () => {
    expect(canonicalizeToolUse('Write', { file_path: './hi.txt', content: 'hi' })).toEqual({
      kind: 'file.write',
      canonicalInput: { path: './hi.txt', content: 'hi' },
    })
  })

  test('Edit with replace_all', () => {
    expect(
      canonicalizeToolUse('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b', replace_all: true }),
    ).toEqual({
      kind: 'file.edit',
      canonicalInput: { path: '/a.ts', oldText: 'a', newText: 'b', replaceAll: true },
    })
  })

  test('Bash', () => {
    expect(canonicalizeToolUse('Bash', { command: 'ls', description: 'list' })).toEqual({
      kind: 'shell.exec',
      canonicalInput: { command: 'ls', description: 'list' },
    })
  })

  test('Grep with -i / -C', () => {
    const res = canonicalizeToolUse('Grep', { pattern: 'TODO', path: '/src', '-i': true, '-C': 2 })
    expect(res.kind).toBe('text.search')
    expect(res.canonicalInput).toEqual({ pattern: 'TODO', path: '/src', caseInsensitive: true, contextLines: 2 })
  })

  test('Task with subagent_type', () => {
    expect(canonicalizeToolUse('Task', { subagent_type: 'gp', prompt: 'go' })).toEqual({
      kind: 'task.spawn',
      canonicalInput: { agent: 'gp', prompt: 'go' },
    })
  })

  test('mcp__rclaude__notify -> mcp.claudewerk.notify', () => {
    const res = canonicalizeToolUse('mcp__rclaude__notify', { title: 't' })
    expect(res.kind).toBe('mcp.claudewerk.notify')
  })
})

describe('canonicalizeToolUse -- ACP/opencode legacy (lowercase + camelCase)', () => {
  test('read camelCase filePath', () => {
    expect(canonicalizeToolUse('read', { filePath: '/etc/hosts' })).toEqual({
      kind: 'file.read',
      canonicalInput: { path: '/etc/hosts' },
    })
  })

  test('write camelCase', () => {
    expect(canonicalizeToolUse('write', { filePath: '/x.txt', content: 'hi' })).toEqual({
      kind: 'file.write',
      canonicalInput: { path: '/x.txt', content: 'hi' },
    })
  })

  test('edit camelCase oldString/newString', () => {
    expect(canonicalizeToolUse('edit', { filePath: '/a.ts', oldString: 'a', newString: 'b' })).toEqual({
      kind: 'file.edit',
      canonicalInput: { path: '/a.ts', oldText: 'a', newText: 'b' },
    })
  })

  test('bash workdir -> cwd', () => {
    expect(canonicalizeToolUse('bash', { command: 'ls', workdir: '/tmp' })).toEqual({
      kind: 'shell.exec',
      canonicalInput: { command: 'ls', cwd: '/tmp' },
    })
  })

  test('grep with include (opencode) -> glob', () => {
    expect(canonicalizeToolUse('grep', { pattern: 'x', path: '/src', include: '*.ts' })).toEqual({
      kind: 'text.search',
      canonicalInput: { pattern: 'x', path: '/src', glob: '*.ts' },
    })
  })

  test('todowrite priority preserved', () => {
    const todos = [{ content: 'A', status: 'pending', priority: 'high' }]
    expect(canonicalizeToolUse('todowrite', { todos })).toEqual({
      kind: 'todo.write',
      canonicalInput: { todos },
    })
  })

  test('claudwerk_notify -> mcp.claudewerk.notify (drift fix)', () => {
    expect(canonicalizeToolUse('claudwerk_notify', { title: 'hi' }).kind).toBe('mcp.claudewerk.notify')
  })

  test('underscore tool with non-brand prefix -> agent.unknown', () => {
    expect(canonicalizeToolUse('some_random_tool', { foo: 1 }).kind).toBe('agent.unknown')
  })
})

describe('ensureCanonical', () => {
  test('mutates legacy tool_use block', () => {
    const block: TranscriptContentBlock = { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/x' } }
    ensureCanonical(block)
    expect(block.kind).toBe('file.read')
    expect(block.canonicalInput).toEqual({ path: '/x' })
  })

  test('idempotent on already-translated block (kind + raw both present)', () => {
    const block: TranscriptContentBlock = {
      type: 'tool_use',
      id: 'tu_1',
      name: 'Read',
      input: { path: '/canonical' },
      kind: 'file.read',
      canonicalInput: { path: '/canonical' },
      raw: { backend: 'claude', name: 'Read', input: { file_path: '/canonical' } },
    }
    ensureCanonical(block)
    expect(block.input).toEqual({ path: '/canonical' })
    expect((block.raw as { input: { file_path: string } }).input.file_path).toBe('/canonical')
  })

  test('legacy entry without raw -- shim synthesizes raw and overwrites input with canonical', () => {
    const block: TranscriptContentBlock = {
      type: 'tool_use',
      id: 'tu_1',
      name: 'Read',
      input: { file_path: '/x' },
    }
    ensureCanonical(block)
    expect(block.input).toEqual({ path: '/x' })
    expect(block.raw).toEqual({ backend: 'claude', name: 'Read', input: { file_path: '/x' } })
  })

  test('non tool_use block unchanged', () => {
    const block: TranscriptContentBlock = { type: 'text', text: 'hi' }
    const before = { ...block }
    ensureCanonical(block)
    expect(block).toEqual(before)
  })

  test('toxic-mammoth-style ACP block: lowercase name + camelCase input', () => {
    // Real shape from conversation 54831a0a-2461-479e-94b1-34968ee26164:
    const block: TranscriptContentBlock = {
      type: 'tool_use',
      id: 'call_1',
      name: 'read',
      input: { filePath: '/Users/jonas/projects/remote-claude/web/src/x.tsx', limit: 100, offset: 0 },
    }
    ensureCanonical(block)
    expect(block.kind).toBe('file.read')
    expect(block.canonicalInput).toEqual({
      path: '/Users/jonas/projects/remote-claude/web/src/x.tsx',
      limit: 100,
      offset: 0,
    })
  })
})
