/**
 * opencode NDJSON dialect -> CLAUDEWERK canonical vocabulary.
 *
 * The opencode `run --format json` NDJSON path delivers the SAME tool
 * shape as opencode-via-ACP (lowercase tool names, camelCase input keys).
 * This translator produces the same canonical kind/canonicalInput/raw,
 * but with backend = 'opencode' (vs 'acp:opencode' for the ACP host).
 *
 * Mutates blocks in place. Idempotent.
 *
 * Scope note: the mapping logic mirrors src/acp-agent-host/dialect/
 * from-acp-generic.ts. Duplicated rather than cross-imported because the
 * two agent hosts ship as separate npm packages and we don't want
 * opencode-host pulling in the entire acp-agent-host bundle. If a third
 * camelCase backend appears, lift this into src/shared/.
 */

import type { TranscriptContentBlock } from '../../shared/protocol'
import {
  type FileEditInput,
  type FileGlobInput,
  type FileReadInput,
  type FileWriteInput,
  mcpKind,
  type ShellExecInput,
  type TaskSpawnInput,
  type TextSearchInput,
  type TodoWriteInput,
  type ToolKind,
  type ToolResult,
  type WebFetchInput,
  type WebSearchInput,
} from '../../shared/tool-vocab'

const OPENCODE_BACKEND = 'opencode'

export function translateOpencodeNdjsonToolUse(block: TranscriptContentBlock): void {
  if (block.type !== 'tool_use') return
  if (block.kind) return
  const rawName = block.name ?? ''
  const rawInput = (block.input ?? {}) as Record<string, unknown>
  block.raw = { backend: OPENCODE_BACKEND, name: rawName, input: rawInput }
  const { kind, canonicalInput } = mapToolUse(rawName, rawInput)
  block.kind = kind
  block.canonicalInput = canonicalInput as Record<string, unknown>
}

/** Translate an opencode NDJSON tool_result block. The NDJSON path packs
 *  result content directly into block.content (no <path>/<type>/<content>
 *  wrapper -- that's an ACP-only thing). The state object from the
 *  source event provides timing (`time.start` / `time.end`) and status,
 *  which we surface in the canonical envelope. */
export function translateOpencodeNdjsonToolResult(
  block: TranscriptContentBlock,
  state: { sourceToolName: string; durationMs?: number; status?: string },
): void {
  if (block.type !== 'tool_result') return
  if (block.result) return

  block.raw = {
    backend: OPENCODE_BACKEND,
    name: state.sourceToolName,
    content: block.content,
    ...(state.status ? { status: state.status } : {}),
    ...(typeof state.durationMs === 'number' ? { durationMs: state.durationMs } : {}),
    ...(block.is_error ? { isError: true } : {}),
  }

  block.result = mapToolResult(state.sourceToolName, block.content, state, !!block.is_error) as unknown as {
    kind: string
    [k: string]: unknown
  }
}

// ---------------------------------------------------------------------------
// tool_use mapping (mirror of from-acp-generic.mapAcpToolUse)
// ---------------------------------------------------------------------------

function mapToolUse(
  name: string,
  input: Record<string, unknown>,
): { kind: ToolKind; canonicalInput: Record<string, unknown> } {
  const r = (kind: ToolKind, canonical: object) => ({
    kind,
    canonicalInput: canonical as Record<string, unknown>,
  })
  switch (name.toLowerCase()) {
    case 'read':
      return r('file.read', readInput(input))
    case 'write':
      return r('file.write', writeInput(input))
    case 'edit':
      return r('file.edit', editInput(input))
    case 'glob':
      return r('file.glob', globInput(input))
    case 'grep':
      return r('text.search', grepInput(input))
    case 'bash':
    case 'shell':
      return r('shell.exec', bashInput(input))
    case 'task':
    case 'agent':
      return r('task.spawn', taskInput(input))
    case 'todowrite':
    case 'todo_write':
      return r('todo.write', todoInput(input))
    case 'webfetch':
    case 'web_fetch':
      return r('web.fetch', webFetchInput(input))
    case 'websearch':
    case 'web_search':
      return r('web.search', webSearchInput(input))
    default: {
      // opencode native MCP names: `<server>_<tool>`. Conservative
      // routing: only emit mcp.* when the prefix is the CLAUDEWERK brand
      // (or its drift spellings). All other underscore-bearing names
      // fall through to agent.unknown.
      if (name.includes('_')) {
        const idx = name.indexOf('_')
        const server = normalizeMcpServerName(name.slice(0, idx))
        const tool = name.slice(idx + 1)
        if (server === 'claudewerk') {
          return r(mcpKind(server, tool), { ...input })
        }
      }
      return r('agent.unknown', { ...input })
    }
  }
}

function readInput(input: Record<string, unknown>): FileReadInput {
  const out: FileReadInput = { path: stringOr(input.filePath ?? input.file_path, '') }
  if (typeof input.offset === 'number') out.offset = input.offset
  if (typeof input.limit === 'number') out.limit = input.limit
  return out
}

function writeInput(input: Record<string, unknown>): FileWriteInput {
  return {
    path: stringOr(input.filePath ?? input.file_path, ''),
    content: stringOr(input.content, ''),
  }
}

function editInput(input: Record<string, unknown>): FileEditInput {
  const out: FileEditInput = {
    path: stringOr(input.filePath ?? input.file_path, ''),
    oldText: stringOr(input.oldString ?? input.old_string, ''),
    newText: stringOr(input.newString ?? input.new_string, ''),
  }
  if (typeof input.replaceAll === 'boolean') out.replaceAll = input.replaceAll
  else if (typeof input.replace_all === 'boolean') out.replaceAll = input.replace_all
  return out
}

function globInput(input: Record<string, unknown>): FileGlobInput {
  const out: FileGlobInput = { pattern: stringOr(input.pattern, '') }
  if (typeof input.path === 'string') out.cwd = input.path
  return out
}

function grepInput(input: Record<string, unknown>): TextSearchInput {
  const out: TextSearchInput = { pattern: stringOr(input.pattern, '') }
  if (typeof input.path === 'string') out.path = input.path
  const glob = input.glob ?? input.include
  if (typeof glob === 'string') out.glob = glob
  if (typeof input.caseInsensitive === 'boolean') out.caseInsensitive = input.caseInsensitive
  if (typeof input.contextLines === 'number') out.contextLines = input.contextLines
  return out
}

function bashInput(input: Record<string, unknown>): ShellExecInput {
  const out: ShellExecInput = { command: stringOr(input.command, '') }
  if (typeof input.description === 'string') out.description = input.description
  if (typeof input.workdir === 'string') out.cwd = input.workdir
  else if (typeof input.cwd === 'string') out.cwd = input.cwd
  if (typeof input.timeout === 'number') out.timeoutMs = input.timeout
  if (typeof input.timeoutMs === 'number') out.timeoutMs = input.timeoutMs
  return out
}

function taskInput(input: Record<string, unknown>): TaskSpawnInput {
  return {
    agent: stringOr(input.subagent_type ?? input.agent ?? input.subagentType, ''),
    prompt: stringOr(input.prompt, ''),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
  }
}

function todoInput(input: Record<string, unknown>): TodoWriteInput {
  const todos = Array.isArray(input.todos) ? (input.todos as TodoWriteInput['todos']) : []
  return { todos }
}

function webFetchInput(input: Record<string, unknown>): WebFetchInput {
  return {
    url: stringOr(input.url, ''),
    ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
  }
}

function webSearchInput(input: Record<string, unknown>): WebSearchInput {
  const out: WebSearchInput = { query: stringOr(input.query, '') }
  if (Array.isArray(input.allowedDomains)) out.allowedDomains = input.allowedDomains as string[]
  if (Array.isArray(input.blockedDomains)) out.blockedDomains = input.blockedDomains as string[]
  return out
}

function normalizeMcpServerName(server: string): string {
  if (server === 'rclaude' || server === 'claudwerk') return 'claudewerk'
  return server
}

// ---------------------------------------------------------------------------
// tool_result mapping
// ---------------------------------------------------------------------------

function mapToolResult(
  sourceTool: string,
  content: unknown,
  state: { durationMs?: number },
  isError: boolean,
): ToolResult {
  if (isError) {
    return { kind: 'error', message: stringifyContent(content) || 'Tool error' }
  }
  switch (sourceTool.toLowerCase()) {
    case 'bash':
    case 'shell': {
      const stdout = stringifyContent(content)
      return {
        kind: 'shell',
        stdout,
        ...(typeof state.durationMs === 'number' ? { durationMs: state.durationMs } : {}),
      }
    }
    case 'read': {
      // opencode NDJSON does NOT use the <path>/<type>/<content> wrapper;
      // the output string is the raw file content. Without a media-type
      // hint we default to text/plain.
      return { kind: 'file', mediaType: 'text/plain', text: stringifyContent(content) }
    }
    case 'write':
    case 'edit':
      return { kind: 'text', text: stringifyContent(content) }
    default: {
      const text = stringifyContent(content)
      if (text) return { kind: 'text', text }
      return { kind: 'unknown', payload: content }
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
          return (c as { text: string }).text
        }
        return ''
      })
      .join('')
  }
  return ''
}
