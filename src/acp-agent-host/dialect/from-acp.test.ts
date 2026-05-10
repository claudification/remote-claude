import { describe, expect, test } from 'bun:test'
import type { TranscriptContentBlock } from '../../shared/protocol'
import { acpBackendId, translateAcpToolResult, translateAcpToolUse } from './from-acp'
import { parseAcpReadWrapper } from './from-acp-generic'

const OPENCODE_CTX = { acpAgent: 'opencode' }
const CODEX_CTX = { acpAgent: 'codex' }

function toolUse(name: string, input: Record<string, unknown>, id = 'call_1'): TranscriptContentBlock {
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

describe('acpBackendId -- backend identifier', () => {
  test('opencode -> acp:opencode', () => {
    expect(acpBackendId('opencode')).toBe('acp:opencode')
  })
  test('codex -> acp:codex', () => {
    expect(acpBackendId('codex')).toBe('acp:codex')
  })
  test('gemini-acp -> acp:gemini (suffix stripped)', () => {
    expect(acpBackendId('gemini-acp')).toBe('acp:gemini')
  })
  test('case insensitive', () => {
    expect(acpBackendId('OpenCode')).toBe('acp:opencode')
  })
})

describe('translateAcpToolUse -- opencode (canonical kinds)', () => {
  test('read -> file.read with filePath -> path', () => {
    const block = toolUse('read', { filePath: '/etc/hosts', limit: 5 })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe('file.read')
    expect(block.canonicalInput).toEqual({ path: '/etc/hosts', limit: 5 })
    expect(block.raw).toEqual({
      backend: 'acp:opencode',
      name: 'read',
      input: { filePath: '/etc/hosts', limit: 5 },
    })
  })

  test('write -> file.write with filePath -> path', () => {
    const block = toolUse('write', { filePath: '/x.txt', content: 'hello' })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe('file.write')
    expect(block.canonicalInput).toEqual({ path: '/x.txt', content: 'hello' })
  })

  test('edit -> file.edit with camelCase keys', () => {
    const block = toolUse('edit', { filePath: '/a.ts', oldString: 'foo', newString: 'bar' })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe('file.edit')
    expect(block.canonicalInput).toEqual({ path: '/a.ts', oldText: 'foo', newText: 'bar' })
  })

  test('grep -> text.search with include -> glob', () => {
    const block = toolUse('grep', { pattern: 'TODO', path: '/src', include: '*.ts' })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe('text.search')
    expect(block.canonicalInput).toEqual({ pattern: 'TODO', path: '/src', glob: '*.ts' })
  })

  test('bash -> shell.exec with workdir -> cwd', () => {
    const block = toolUse('bash', { command: 'ls', description: 'list', workdir: '/tmp', timeout: 5000 })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe('shell.exec')
    expect(block.canonicalInput).toEqual({
      command: 'ls',
      description: 'list',
      cwd: '/tmp',
      timeoutMs: 5000,
    })
  })

  test('task -> task.spawn', () => {
    const block = toolUse('task', { subagent_type: 'gp', prompt: 'go', description: 'd' })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe('task.spawn')
    expect(block.canonicalInput).toEqual({ agent: 'gp', prompt: 'go', description: 'd' })
  })

  test('todowrite -> todo.write with opencode priority field preserved', () => {
    const todos = [
      { content: 'A', status: 'completed', priority: 'high' },
      { content: 'B', status: 'in_progress', priority: 'medium' },
    ]
    const block = toolUse('todowrite', { todos })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe('todo.write')
    expect(block.canonicalInput).toEqual({ todos })
  })

  test('glob -> file.glob', () => {
    const block = toolUse('glob', { pattern: '**/*.ts' })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe('file.glob')
    expect(block.canonicalInput).toEqual({ pattern: '**/*.ts' })
  })

  test('webfetch / websearch', () => {
    const w1 = toolUse('webfetch', { url: 'https://x.com', prompt: 'title' })
    translateAcpToolUse(w1, OPENCODE_CTX)
    expect(w1.kind).toBe('web.fetch')
    expect(w1.canonicalInput).toEqual({ url: 'https://x.com', prompt: 'title' })

    const w2 = toolUse('websearch', { query: 'rust' })
    translateAcpToolUse(w2, OPENCODE_CTX)
    expect(w2.kind).toBe('web.search')
    expect(w2.canonicalInput).toEqual({ query: 'rust' })
  })

  test('claudwerk_notify -> mcp.claudewerk.notify (brand normalize)', () => {
    const block = toolUse('claudwerk_notify', { title: 'hi' })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe('mcp.claudewerk.notify')
  })

  test('unknown server prefix -> agent.unknown (no false-positive MCP routing)', () => {
    const block = toolUse('some_random_tool', { foo: 1 })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe('agent.unknown')
    expect(block.canonicalInput).toEqual({ foo: 1 })
  })

  test('idempotent', () => {
    const block = toolUse('read', { filePath: '/x' })
    translateAcpToolUse(block, OPENCODE_CTX)
    const k = block.kind
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.kind).toBe(k)
  })
})

describe('translateAcpToolUse -- codex (generic fallback)', () => {
  test('codex read works via generic mapper', () => {
    const block = toolUse('read', { filePath: '/x' })
    translateAcpToolUse(block, CODEX_CTX)
    expect(block.kind).toBe('file.read')
    expect((block.raw as { backend: string }).backend).toBe('acp:codex')
  })
})

describe('parseAcpReadWrapper -- opencode read result envelope', () => {
  test('text file', () => {
    const wrapped =
      '<path>/etc/hosts</path>\n' + '<type>file</type>\n' + '<content>\n1: ##\n2: # Host Database\n</content>'
    const parsed = parseAcpReadWrapper(wrapped)
    expect(parsed).toEqual({ mediaType: 'text/plain', text: '1: ##\n2: # Host Database' })
  })

  test('json file media type', () => {
    const wrapped = '<path>/cfg.json</path>\n<type>file</type>\n<content>\n{}\n</content>'
    expect(parseAcpReadWrapper(wrapped)?.mediaType).toBe('application/json')
  })

  test('image png media type', () => {
    const wrapped = '<path>/x.png</path>\n<type>image</type>\n<content>\nbinary\n</content>'
    expect(parseAcpReadWrapper(wrapped)?.mediaType).toBe('image/png')
  })

  test('non-wrapped content returns null', () => {
    expect(parseAcpReadWrapper('plain text without wrapper')).toBeNull()
  })
})

describe('translateAcpToolResult -- opencode result envelopes', () => {
  test('read result with wrapper -> file envelope', () => {
    const block = toolResult('call_1', '<path>/etc/hosts</path>\n<type>file</type>\n<content>\n##\n# Host\n</content>')
    translateAcpToolResult(block, { sourceToolName: 'read' }, OPENCODE_CTX)
    expect(block.result).toEqual({
      kind: 'file',
      mediaType: 'text/plain',
      text: '##\n# Host',
    })
  })

  test('bash result -> shell envelope with exit metadata', () => {
    const block = toolResult('call_2', 'total 8\n.\n..')
    translateAcpToolResult(block, { sourceToolName: 'bash', metadata: { exit: 0, durationMs: 42 } }, OPENCODE_CTX)
    expect(block.result).toEqual({
      kind: 'shell',
      stdout: 'total 8\n.\n..',
      exitCode: 0,
      durationMs: 42,
    })
  })

  test('bash with non-zero exit', () => {
    const block = toolResult('call_3', 'oops')
    translateAcpToolResult(block, { sourceToolName: 'bash', metadata: { exit: 1 } }, OPENCODE_CTX)
    expect(block.result).toEqual({ kind: 'shell', stdout: 'oops', exitCode: 1 })
  })

  test('write result -> text envelope', () => {
    const block = toolResult('call_4', 'Wrote file successfully.')
    translateAcpToolResult(block, { sourceToolName: 'write' }, OPENCODE_CTX)
    expect(block.result).toEqual({ kind: 'text', text: 'Wrote file successfully.' })
  })

  test('is_error -> error envelope', () => {
    const block = toolResult('call_5', 'permission denied', true)
    translateAcpToolResult(block, { sourceToolName: 'read' }, OPENCODE_CTX)
    expect(block.result).toEqual({ kind: 'error', message: 'permission denied' })
  })

  test('idempotent', () => {
    const block = toolResult('call_1', 'x')
    translateAcpToolResult(block, { sourceToolName: 'bash' }, OPENCODE_CTX)
    const r = block.result
    translateAcpToolResult(block, { sourceToolName: 'bash', metadata: { exit: 99 } }, OPENCODE_CTX)
    expect(block.result).toBe(r)
  })

  test('unknown source tool -> text envelope when content available', () => {
    const block = toolResult('call_x', 'hello')
    translateAcpToolResult(block, { sourceToolName: 'mystery' }, OPENCODE_CTX)
    expect(block.result).toEqual({ kind: 'text', text: 'hello' })
  })
})

describe('raw field discipline -- ACP', () => {
  test('raw preserves full input + metadata across kinds', () => {
    const block = toolUse('grep', { pattern: 'x', path: '/src', include: '*.ts' })
    translateAcpToolUse(block, OPENCODE_CTX)
    expect(block.raw).toEqual({
      backend: 'acp:opencode',
      name: 'grep',
      input: { pattern: 'x', path: '/src', include: '*.ts' },
    })
  })

  test('result raw preserves rawOutput and metadata', () => {
    const block = toolResult('call_1', 'stdout text')
    translateAcpToolResult(
      block,
      { sourceToolName: 'bash', rawOutput: { output: 'stdout text', metadata: { exit: 0 } }, metadata: { exit: 0 } },
      OPENCODE_CTX,
    )
    expect(block.raw).toMatchObject({
      backend: 'acp:opencode',
      name: 'bash',
      rawOutput: { output: 'stdout text', metadata: { exit: 0 } },
      metadata: { exit: 0 },
    })
  })
})
