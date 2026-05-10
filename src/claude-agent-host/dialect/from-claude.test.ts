import { describe, expect, test } from 'bun:test'
import type { TranscriptContentBlock } from '../../shared/protocol'
import { translateClaudeToolResult, translateClaudeToolUse } from './from-claude'

function toolUse(name: string, input: Record<string, unknown>, id = 'tu_1'): TranscriptContentBlock {
  return { type: 'tool_use', id, name, input }
}

function toolResult(useId: string, content: unknown, isError = false): TranscriptContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: useId,
    content: content as string,
    ...(isError ? { is_error: true } : {}),
  }
}

describe('translateClaudeToolUse -- canonical kinds', () => {
  test('Read -> file.read with snake_case -> path', () => {
    const block = toolUse('Read', { file_path: '/etc/hosts', limit: 5 })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('file.read')
    expect(block.canonicalInput).toEqual({ path: '/etc/hosts', limit: 5 })
    expect(block.raw).toEqual({
      backend: 'claude',
      name: 'Read',
      input: { file_path: '/etc/hosts', limit: 5 },
    })
    // input is REPLACED with canonical shape; original dialect lives on raw.input
    expect(block.name).toBe('Read')
    expect(block.input).toEqual({ path: '/etc/hosts', limit: 5 })
  })

  test('Write -> file.write', () => {
    const block = toolUse('Write', { file_path: './hello.txt', content: 'hello' })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('file.write')
    expect(block.canonicalInput).toEqual({ path: './hello.txt', content: 'hello' })
  })

  test('Edit -> file.edit with replace_all', () => {
    const block = toolUse('Edit', {
      file_path: '/a.ts',
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
    })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('file.edit')
    expect(block.canonicalInput).toEqual({
      path: '/a.ts',
      oldText: 'foo',
      newText: 'bar',
      replaceAll: true,
    })
  })

  test('MultiEdit -> file.edit', () => {
    const block = toolUse('MultiEdit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('file.edit')
  })

  test('Glob -> file.glob with optional cwd', () => {
    const block = toolUse('Glob', { pattern: '**/*.ts', path: '/src' })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('file.glob')
    expect(block.canonicalInput).toEqual({ pattern: '**/*.ts', cwd: '/src' })
  })

  test('Grep -> text.search with -i and -C remapped', () => {
    const block = toolUse('Grep', {
      pattern: 'TODO',
      path: '/src',
      glob: '*.ts',
      '-i': true,
      '-C': 2,
      output_mode: 'content',
      head_limit: 50,
    })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('text.search')
    expect(block.canonicalInput).toEqual({
      pattern: 'TODO',
      path: '/src',
      glob: '*.ts',
      caseInsensitive: true,
      contextLines: 2,
      outputMode: 'content',
      headLimit: 50,
    })
  })

  test('Bash -> shell.exec', () => {
    const block = toolUse('Bash', {
      command: 'ls -la',
      description: 'list',
      timeout: 5000,
      run_in_background: true,
    })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('shell.exec')
    expect(block.canonicalInput).toEqual({
      command: 'ls -la',
      description: 'list',
      timeoutMs: 5000,
      runInBackground: true,
    })
  })

  test('Task -> task.spawn with subagent_type -> agent', () => {
    const block = toolUse('Task', {
      subagent_type: 'general-purpose',
      prompt: 'Find foo',
      description: 'search',
    })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('task.spawn')
    expect(block.canonicalInput).toEqual({ agent: 'general-purpose', prompt: 'Find foo', description: 'search' })
  })

  test('TodoWrite -> todo.write', () => {
    const todos = [{ content: 'A', status: 'pending', activeForm: 'Doing A' }]
    const block = toolUse('TodoWrite', { todos })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('todo.write')
    expect(block.canonicalInput).toEqual({ todos })
  })

  test('WebFetch -> web.fetch', () => {
    const block = toolUse('WebFetch', { url: 'https://example.com', prompt: 'title' })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('web.fetch')
    expect(block.canonicalInput).toEqual({ url: 'https://example.com', prompt: 'title' })
  })

  test('WebSearch -> web.search with allowed_domains', () => {
    const block = toolUse('WebSearch', { query: 'rust', allowed_domains: ['rust-lang.org'] })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('web.search')
    expect(block.canonicalInput).toEqual({ query: 'rust', allowedDomains: ['rust-lang.org'] })
  })

  test('NotebookEdit -> notebook.edit with notebook_path -> path', () => {
    const block = toolUse('NotebookEdit', {
      notebook_path: '/n.ipynb',
      cell_id: 'c1',
      new_source: 'x',
      cell_type: 'code',
      edit_mode: 'replace',
    })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('notebook.edit')
    expect(block.canonicalInput).toEqual({
      path: '/n.ipynb',
      cellId: 'c1',
      newSource: 'x',
      cellType: 'code',
      editMode: 'replace',
    })
  })

  test('REPL -> repl.exec', () => {
    const block = toolUse('REPL', { code: '1+1', description: 'arithmetic' })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('repl.exec')
    expect(block.canonicalInput).toEqual({ code: '1+1', description: 'arithmetic' })
  })

  test('mcp__rclaude__* -> mcp.claudewerk.* (brand normalize)', () => {
    const block = toolUse('mcp__rclaude__notify', { title: 'hi' })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('mcp.claudewerk.notify')
    expect(block.canonicalInput).toEqual({ title: 'hi' })
  })

  test('mcp__claudewerk__* preserved', () => {
    const block = toolUse('mcp__claudewerk__share_file', { path: '/x' })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('mcp.claudewerk.share_file')
  })

  test('mcp__other-server__tool preserved as-is', () => {
    const block = toolUse('mcp__firecrawl__search', { query: 'x' })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('mcp.firecrawl.search')
  })

  test('unknown tool -> agent.unknown with raw preserved', () => {
    const block = toolUse('XyzWeirdTool', { foo: 1 })
    translateClaudeToolUse(block)
    expect(block.kind).toBe('agent.unknown')
    expect(block.canonicalInput).toEqual({ foo: 1 })
    expect(block.raw).toEqual({ backend: 'claude', name: 'XyzWeirdTool', input: { foo: 1 } })
  })

  test('idempotent -- second call no-ops', () => {
    const block = toolUse('Read', { file_path: '/a' })
    translateClaudeToolUse(block)
    const firstKind = block.kind
    block.input = { file_path: '/MUTATED' } // try to confuse it
    translateClaudeToolUse(block)
    expect(block.kind).toBe(firstKind)
    // raw was captured on first call, not overwritten
    expect((block.raw as unknown as { input: { file_path: string } }).input.file_path).toBe('/a')
  })

  test('non tool_use blocks ignored', () => {
    const block: TranscriptContentBlock = { type: 'text', text: 'hi' }
    translateClaudeToolUse(block)
    expect(block.kind).toBeUndefined()
    expect(block.raw).toBeUndefined()
  })
})

describe('translateClaudeToolResult -- canonical envelope', () => {
  test('Bash result -> shell envelope from toolUseResult sidecar', () => {
    const block = toolResult('tu_1', 'total 8\n...')
    const tur = { stdout: 'total 8\n...', stderr: '', interrupted: false, isImage: false }
    const names = new Map([['tu_1', 'Bash']])
    translateClaudeToolResult(block, tur, names)
    expect(block.result).toEqual({ kind: 'shell', stdout: 'total 8\n...' })
    expect(block.raw).toMatchObject({ backend: 'claude', name: 'Bash', toolUseResult: tur })
  })

  test('Bash with stderr included', () => {
    const block = toolResult('tu_1', 'oops')
    const tur = { stdout: 'a', stderr: 'b', interrupted: false }
    translateClaudeToolResult(block, tur, new Map([['tu_1', 'Bash']]))
    expect(block.result).toEqual({ kind: 'shell', stdout: 'a', stderr: 'b' })
  })

  test('Bash interrupted -> truncated flag', () => {
    const block = toolResult('tu_1', 'partial')
    const tur = { stdout: 'partial', stderr: '', interrupted: true }
    translateClaudeToolResult(block, tur, new Map([['tu_1', 'Bash']]))
    expect(block.result).toEqual({ kind: 'shell', stdout: 'partial', truncated: true })
  })

  test('Read result -> file envelope using file.content', () => {
    const block = toolResult('tu_2', '1\t##\n2\t# Host Database')
    const tur = {
      type: 'text',
      file: {
        filePath: '/etc/hosts',
        content: '##\n# Host Database',
        numLines: 2,
        startLine: 1,
        totalLines: 14,
      },
    }
    translateClaudeToolResult(block, tur, new Map([['tu_2', 'Read']]))
    expect(block.result).toEqual({
      kind: 'file',
      mediaType: 'text/plain',
      text: '##\n# Host Database',
    })
  })

  test('Write result -> text envelope', () => {
    const block = toolResult('tu_3', 'File created successfully at: ./hello.txt')
    const tur = { type: 'create', filePath: './hello.txt', content: 'hello' }
    translateClaudeToolResult(block, tur, new Map([['tu_3', 'Write']]))
    expect(block.result).toEqual({
      kind: 'text',
      text: 'File created successfully at: ./hello.txt',
    })
  })

  test('is_error -> error envelope', () => {
    const block = toolResult('tu_4', 'permission denied', true)
    translateClaudeToolResult(block, undefined, new Map([['tu_4', 'Read']]))
    expect(block.result).toEqual({ kind: 'error', message: 'permission denied' })
  })

  test('unknown source tool -> text or unknown envelope', () => {
    const block = toolResult('tu_5', 'arbitrary text')
    translateClaudeToolResult(block, undefined, new Map())
    expect(block.result).toEqual({ kind: 'text', text: 'arbitrary text' })
  })

  test('content array stringified', () => {
    const block = toolResult('tu_6', [{ type: 'text', text: 'hello' }] as unknown as string)
    translateClaudeToolResult(block, undefined, new Map())
    expect(block.result).toEqual({ kind: 'text', text: 'hello' })
  })

  test('idempotent -- second call no-ops', () => {
    const block = toolResult('tu_1', 'x')
    translateClaudeToolResult(block, { stdout: 'x' }, new Map([['tu_1', 'Bash']]))
    const first = block.result
    translateClaudeToolResult(block, { stdout: 'MUTATED' }, new Map([['tu_1', 'Bash']]))
    expect(block.result).toBe(first)
  })

  test('non tool_result blocks ignored', () => {
    const block: TranscriptContentBlock = { type: 'text', text: 'hi' }
    translateClaudeToolResult(block, undefined, new Map())
    expect(block.result).toBeUndefined()
  })
})

describe('raw field discipline', () => {
  test('raw preserved verbatim across all tool kinds', () => {
    const samples = [
      { name: 'Read', input: { file_path: '/x', limit: 10 } },
      { name: 'Write', input: { file_path: '/y', content: 'z' } },
      { name: 'Edit', input: { file_path: '/z', old_string: 'a', new_string: 'b' } },
      { name: 'Bash', input: { command: 'ls', description: 'list' } },
      { name: 'mcp__rclaude__notify', input: { title: 't' } },
    ]
    for (const s of samples) {
      const block = toolUse(s.name, s.input)
      translateClaudeToolUse(block)
      expect(block.raw).toEqual({ backend: 'claude', name: s.name, input: s.input })
    }
  })
})
