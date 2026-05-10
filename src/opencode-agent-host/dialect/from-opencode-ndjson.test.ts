import { describe, expect, test } from 'bun:test'
import type { TranscriptContentBlock } from '../../shared/protocol'
import { translateOpencodeNdjsonToolResult, translateOpencodeNdjsonToolUse } from './from-opencode-ndjson'

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

describe('translateOpencodeNdjsonToolUse -- canonical kinds', () => {
  test('read -> file.read with backend opencode', () => {
    const block = toolUse('read', { filePath: '/etc/hosts', limit: 5 })
    translateOpencodeNdjsonToolUse(block)
    expect(block.kind).toBe('file.read')
    expect(block.canonicalInput).toEqual({ path: '/etc/hosts', limit: 5 })
    expect(block.raw).toEqual({
      backend: 'opencode',
      name: 'read',
      input: { filePath: '/etc/hosts', limit: 5 },
    })
  })

  test('write -> file.write', () => {
    const block = toolUse('write', { filePath: '/x.txt', content: 'hi' })
    translateOpencodeNdjsonToolUse(block)
    expect(block.kind).toBe('file.write')
    expect(block.canonicalInput).toEqual({ path: '/x.txt', content: 'hi' })
  })

  test('edit -> file.edit camelCase keys', () => {
    const block = toolUse('edit', { filePath: '/a.ts', oldString: 'a', newString: 'b' })
    translateOpencodeNdjsonToolUse(block)
    expect(block.kind).toBe('file.edit')
    expect(block.canonicalInput).toEqual({ path: '/a.ts', oldText: 'a', newText: 'b' })
  })

  test('grep -> text.search with include -> glob', () => {
    const block = toolUse('grep', { pattern: 'TODO', path: '/src', include: '*.ts' })
    translateOpencodeNdjsonToolUse(block)
    expect(block.kind).toBe('text.search')
    expect(block.canonicalInput).toEqual({ pattern: 'TODO', path: '/src', glob: '*.ts' })
  })

  test('bash -> shell.exec workdir -> cwd', () => {
    const block = toolUse('bash', { command: 'ls', description: 'list', workdir: '/tmp' })
    translateOpencodeNdjsonToolUse(block)
    expect(block.kind).toBe('shell.exec')
    expect(block.canonicalInput).toEqual({ command: 'ls', description: 'list', cwd: '/tmp' })
  })

  test('todowrite priority field preserved', () => {
    const todos = [{ content: 'A', status: 'pending', priority: 'high' }]
    const block = toolUse('todowrite', { todos })
    translateOpencodeNdjsonToolUse(block)
    expect(block.kind).toBe('todo.write')
    expect(block.canonicalInput).toEqual({ todos })
  })

  test('claudwerk_notify -> mcp.claudewerk.notify (brand drift fixed)', () => {
    const block = toolUse('claudwerk_notify', { title: 'hi' })
    translateOpencodeNdjsonToolUse(block)
    expect(block.kind).toBe('mcp.claudewerk.notify')
  })

  test('unknown underscore tool -> agent.unknown (no false MCP routing)', () => {
    const block = toolUse('some_random_tool', { x: 1 })
    translateOpencodeNdjsonToolUse(block)
    expect(block.kind).toBe('agent.unknown')
  })

  test('idempotent', () => {
    const block = toolUse('read', { filePath: '/x' })
    translateOpencodeNdjsonToolUse(block)
    const k = block.kind
    translateOpencodeNdjsonToolUse(block)
    expect(block.kind).toBe(k)
  })
})

describe('translateOpencodeNdjsonToolResult -- envelopes', () => {
  test('bash result -> shell envelope with durationMs', () => {
    const block = toolResult('call_1', 'total 8\n.\n..')
    translateOpencodeNdjsonToolResult(block, { sourceToolName: 'bash', durationMs: 100 })
    expect(block.result).toEqual({ kind: 'shell', stdout: 'total 8\n.\n..', durationMs: 100 })
  })

  test('read result -> file envelope text/plain', () => {
    const block = toolResult('call_2', '##\n# Host')
    translateOpencodeNdjsonToolResult(block, { sourceToolName: 'read' })
    expect(block.result).toEqual({ kind: 'file', mediaType: 'text/plain', text: '##\n# Host' })
  })

  test('write result -> text envelope', () => {
    const block = toolResult('call_3', 'Wrote.')
    translateOpencodeNdjsonToolResult(block, { sourceToolName: 'write' })
    expect(block.result).toEqual({ kind: 'text', text: 'Wrote.' })
  })

  test('error -> error envelope', () => {
    const block = toolResult('call_4', 'denied', true)
    translateOpencodeNdjsonToolResult(block, { sourceToolName: 'read' })
    expect(block.result).toEqual({ kind: 'error', message: 'denied' })
  })

  test('idempotent', () => {
    const block = toolResult('call_1', 'x')
    translateOpencodeNdjsonToolResult(block, { sourceToolName: 'bash' })
    const r = block.result
    translateOpencodeNdjsonToolResult(block, { sourceToolName: 'bash', durationMs: 99 })
    expect(block.result).toBe(r)
  })
})

describe('raw field discipline -- opencode NDJSON', () => {
  test('raw preserves verbatim camelCase input', () => {
    const block = toolUse('grep', { pattern: 'x', path: '/src', include: '*.ts' })
    translateOpencodeNdjsonToolUse(block)
    expect(block.raw).toEqual({
      backend: 'opencode',
      name: 'grep',
      input: { pattern: 'x', path: '/src', include: '*.ts' },
    })
  })

  test('result raw preserves status + durationMs', () => {
    const block = toolResult('call_1', 'out')
    translateOpencodeNdjsonToolResult(block, {
      sourceToolName: 'bash',
      status: 'completed',
      durationMs: 5,
    })
    expect(block.raw).toEqual({
      backend: 'opencode',
      name: 'bash',
      content: 'out',
      status: 'completed',
      durationMs: 5,
    })
  })
})
