/**
 * Claude API dialect -> CLAUDEWERK canonical vocabulary.
 *
 * Translates Claude's PascalCase tool names + snake_case input keys into the
 * agent-agnostic shape defined in `src/shared/tool-vocab.ts`. The original
 * backend payload is preserved verbatim in `block.raw` so the user can
 * always inspect what Claude actually sent.
 *
 * Mutates blocks in place. Idempotent: if `block.kind` is already set, the
 * translator returns immediately.
 */

import type { TranscriptContentBlock } from '../../shared/protocol'
import {
  type FileEditInput,
  type FileGlobInput,
  type FileReadInput,
  type FileWriteInput,
  mcpKind,
  type NotebookEditInput,
  type ReplExecInput,
  type ShellExecInput,
  type TaskSpawnInput,
  type TextSearchInput,
  type TodoWriteInput,
  type ToolKind,
  type ToolResult,
  type WebFetchInput,
  type WebSearchInput,
} from '../../shared/tool-vocab'

const CLAUDE_BACKEND = 'claude'

/** Translate a Claude API `tool_use` block into canonical CLAUDEWERK shape.
 *  Mutates the block in place. The legacy `name` and `input` fields are
 *  preserved as derived aliases so old readers still work. */
export function translateClaudeToolUse(block: TranscriptContentBlock): void {
  if (block.type !== 'tool_use') return
  if (block.kind) return // idempotent: already translated

  const rawName = block.name ?? ''
  const rawInput = (block.input ?? {}) as Record<string, unknown>

  block.raw = {
    backend: CLAUDE_BACKEND,
    name: rawName,
    input: rawInput,
  }

  const { kind, canonicalInput } = mapClaudeToolUse(rawName, rawInput)
  block.kind = kind
  block.canonicalInput = canonicalInput as Record<string, unknown>
}

/** Translate a Claude API `tool_result` block. Reads the per-entry
 *  `toolUseResult` sidecar (Claude attaches structured result data there,
 *  not on the block). Adds `result` and `raw` to the block. */
export function translateClaudeToolResult(
  block: TranscriptContentBlock,
  toolUseResult: unknown,
  toolNameByUseId: Map<string, string>,
): void {
  if (block.type !== 'tool_result') return
  if (block.result) return // idempotent

  const useId = block.tool_use_id ?? ''
  const sourceTool = (useId && toolNameByUseId.get(useId)) || ''

  block.raw = {
    backend: CLAUDE_BACKEND,
    name: sourceTool,
    content: block.content,
    toolUseResult,
    ...(block.is_error ? { isError: true } : {}),
  }

  block.result = mapClaudeToolResult(sourceTool, block.content, toolUseResult, !!block.is_error) as unknown as {
    kind: string
    [k: string]: unknown
  }
}

// ---------------------------------------------------------------------------
// tool_use mapping
// ---------------------------------------------------------------------------

function mapClaudeToolUse(
  name: string,
  input: Record<string, unknown>,
): { kind: ToolKind; canonicalInput: Record<string, unknown> } {
  const r = (kind: ToolKind, canonical: object) => ({
    kind,
    canonicalInput: canonical as Record<string, unknown>,
  })
  switch (name) {
    case 'Read':
      return r('file.read', claudeReadInput(input))
    case 'Write':
      return r('file.write', claudeWriteInput(input))
    case 'Edit':
    case 'MultiEdit':
      return r('file.edit', claudeEditInput(input))
    case 'Glob':
      return r('file.glob', claudeGlobInput(input))
    case 'Grep':
      return r('text.search', claudeGrepInput(input))
    case 'Bash':
    case 'BashOutput':
      return r('shell.exec', claudeBashInput(input))
    case 'Task':
    case 'Agent':
      return r('task.spawn', claudeTaskInput(input))
    case 'TodoWrite':
      return r('todo.write', claudeTodoInput(input))
    case 'WebFetch':
      return r('web.fetch', claudeWebFetchInput(input))
    case 'WebSearch':
      return r('web.search', claudeWebSearchInput(input))
    case 'NotebookEdit':
      return r('notebook.edit', claudeNotebookEditInput(input))
    case 'REPL':
      return r('repl.exec', claudeReplInput(input))
    default: {
      // Claude MCP names: `mcp__<server>__<tool>`. Normalize the rclaude/
      // claudwerk drift to the canonical brand `claudewerk`.
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        if (parts.length >= 3) {
          const server = normalizeMcpServerName(parts[1])
          const tool = parts.slice(2).join('__')
          return r(mcpKind(server, tool), { ...input })
        }
      }
      return r('agent.unknown', { ...input })
    }
  }
}

function claudeReadInput(input: Record<string, unknown>): FileReadInput {
  const out: FileReadInput = { path: stringOr(input.file_path, '') }
  if (typeof input.offset === 'number') out.offset = input.offset
  if (typeof input.limit === 'number') out.limit = input.limit
  return out
}

function claudeWriteInput(input: Record<string, unknown>): FileWriteInput {
  return {
    path: stringOr(input.file_path, ''),
    content: stringOr(input.content, ''),
  }
}

function claudeEditInput(input: Record<string, unknown>): FileEditInput {
  const out: FileEditInput = {
    path: stringOr(input.file_path, ''),
    oldText: stringOr(input.old_string, ''),
    newText: stringOr(input.new_string, ''),
  }
  if (typeof input.replace_all === 'boolean') out.replaceAll = input.replace_all
  return out
}

function claudeGlobInput(input: Record<string, unknown>): FileGlobInput {
  const out: FileGlobInput = { pattern: stringOr(input.pattern, '') }
  if (typeof input.path === 'string') out.cwd = input.path
  return out
}

function claudeGrepInput(input: Record<string, unknown>): TextSearchInput {
  const out: TextSearchInput = { pattern: stringOr(input.pattern, '') }
  if (typeof input.path === 'string') out.path = input.path
  if (typeof input.glob === 'string') out.glob = input.glob
  if (typeof input['-i'] === 'boolean') out.caseInsensitive = input['-i']
  if (typeof input['-C'] === 'number') out.contextLines = input['-C']
  if (typeof input.output_mode === 'string') out.outputMode = input.output_mode
  if (typeof input.head_limit === 'number') out.headLimit = input.head_limit
  return out
}

function claudeBashInput(input: Record<string, unknown>): ShellExecInput {
  const out: ShellExecInput = { command: stringOr(input.command, '') }
  if (typeof input.description === 'string') out.description = input.description
  if (typeof input.timeout === 'number') out.timeoutMs = input.timeout
  if (typeof input.run_in_background === 'boolean') out.runInBackground = input.run_in_background
  return out
}

function claudeTaskInput(input: Record<string, unknown>): TaskSpawnInput {
  return {
    agent: stringOr(input.subagent_type ?? input.agent, ''),
    prompt: stringOr(input.prompt, ''),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
  }
}

function claudeTodoInput(input: Record<string, unknown>): TodoWriteInput {
  const todos = Array.isArray(input.todos) ? (input.todos as TodoWriteInput['todos']) : []
  return { todos }
}

function claudeWebFetchInput(input: Record<string, unknown>): WebFetchInput {
  return {
    url: stringOr(input.url, ''),
    ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
  }
}

function claudeWebSearchInput(input: Record<string, unknown>): WebSearchInput {
  const out: WebSearchInput = { query: stringOr(input.query, '') }
  if (Array.isArray(input.allowed_domains)) out.allowedDomains = input.allowed_domains as string[]
  if (Array.isArray(input.blocked_domains)) out.blockedDomains = input.blocked_domains as string[]
  return out
}

function claudeNotebookEditInput(input: Record<string, unknown>): NotebookEditInput {
  const out: NotebookEditInput = { path: stringOr(input.notebook_path, '') }
  if (typeof input.cell_id === 'string') out.cellId = input.cell_id
  if (typeof input.new_source === 'string') out.newSource = input.new_source
  if (typeof input.cell_type === 'string') out.cellType = input.cell_type
  if (typeof input.edit_mode === 'string') out.editMode = input.edit_mode
  return out
}

function claudeReplInput(input: Record<string, unknown>): ReplExecInput {
  return {
    code: stringOr(input.code, ''),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
  }
}

/** Normalize MCP server name spelling drift. The CLAUDEWERK brand is the
 *  canonical spelling; `rclaude` and `claudwerk` are legacy aliases that
 *  appear on Claude's side and ACP/opencode's side respectively. */
function normalizeMcpServerName(server: string): string {
  if (server === 'rclaude' || server === 'claudwerk') return 'claudewerk'
  return server
}

// ---------------------------------------------------------------------------
// tool_result mapping
// ---------------------------------------------------------------------------

function mapClaudeToolResult(
  sourceTool: string,
  content: unknown,
  toolUseResult: unknown,
  isError: boolean,
): ToolResult {
  if (isError) {
    return { kind: 'error', message: stringifyContent(content) || 'Tool error' }
  }

  const tur = toolUseResult as Record<string, unknown> | undefined

  switch (sourceTool) {
    case 'Bash':
    case 'BashOutput':
      return mapBashResult(content, tur)
    case 'Read':
      return mapReadResult(content, tur)
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return mapWriteEditResult(content, tur)
    default: {
      const text = stringifyContent(content)
      if (text) return { kind: 'text', text }
      return { kind: 'unknown', payload: tur ?? content }
    }
  }
}

function mapBashResult(content: unknown, tur: Record<string, unknown> | undefined): ToolResult {
  if (!tur) {
    return { kind: 'shell', stdout: stringifyContent(content) }
  }
  const stdout = stringOr(tur.stdout, '')
  const stderr = stringOr(tur.stderr, '')
  const interrupted = tur.interrupted === true
  return {
    kind: 'shell',
    stdout,
    ...(stderr ? { stderr } : {}),
    ...(interrupted ? { truncated: true } : {}),
  }
}

function mapReadResult(content: unknown, tur: Record<string, unknown> | undefined): ToolResult {
  const file = tur?.file as Record<string, unknown> | undefined
  if (file) {
    const mediaType = stringOr(file.type, 'text/plain')
    const text = typeof file.content === 'string' ? (file.content as string) : undefined
    return {
      kind: 'file',
      mediaType,
      ...(text !== undefined ? { text } : {}),
    }
  }
  // No structured sidecar -- fall back to plain text.
  return { kind: 'text', text: stringifyContent(content) }
}

function mapWriteEditResult(content: unknown, tur: Record<string, unknown> | undefined): ToolResult {
  const text = stringifyContent(content)
  if (text) return { kind: 'text', text }
  if (tur) return { kind: 'unknown', payload: tur }
  return { kind: 'text', text: '' }
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
    // Claude content arrays sometimes have { type: 'text', text } items
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
