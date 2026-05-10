/**
 * Generic ACP dialect mapper for agents we haven't bespoke-mapped yet
 * (codex, gemini-acp, ...). Best-effort canonicalization based on the
 * lowercase tool name; falls back to `agent.unknown` with the raw payload
 * preserved verbatim. Brand-spelling drift normalized at the MCP boundary.
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
  type ToolBackend,
  type ToolKind,
  type ToolResult,
  type WebFetchInput,
  type WebSearchInput,
} from '../../shared/tool-vocab'

/** Context wrapping ACP rawOutput for result envelope translation. The
 *  agent-host wires this from the `pending.rawOutput` it captured during
 *  tool_call_update. */
export interface AcpToolResultContext {
  /** Raw output content the ACP agent reported. May already be a string
   *  (opencode wraps results in `<path>/<type>/<content>` for reads). */
  rawOutput?: unknown
  /** Optional metadata bag (exit codes, durations, ...) from rawOutput.metadata. */
  metadata?: { exit?: number; truncated?: boolean; durationMs?: number; description?: string; [k: string]: unknown }
  /** Stable tool name captured at tool_use time. */
  sourceToolName: string
}

export function translateGenericAcpToolUse(block: TranscriptContentBlock, backend: ToolBackend): void {
  if (block.type !== 'tool_use') return
  if (block.kind) return
  const rawName = block.name ?? ''
  const rawInput = (block.input ?? {}) as Record<string, unknown>
  block.raw = { backend, name: rawName, input: rawInput }
  const { kind, canonicalInput } = mapAcpToolUse(rawName, rawInput)
  block.kind = kind
  // Replace input with the canonical shape -- harmonize at the edge so the
  // broker and web see canonical-only on `input`. Original ACP camelCase
  // lives on `raw.input` as the dialect escape hatch.
  block.input = canonicalInput as Record<string, unknown>
  block.canonicalInput = block.input
}

export function translateGenericAcpToolResult(
  block: TranscriptContentBlock,
  ctx: AcpToolResultContext,
  backend: ToolBackend,
): void {
  if (block.type !== 'tool_result') return
  if (block.result) return

  block.raw = {
    backend,
    name: ctx.sourceToolName,
    content: block.content,
    rawOutput: ctx.rawOutput,
    ...(ctx.metadata ? { metadata: ctx.metadata } : {}),
    ...(block.is_error ? { isError: true } : {}),
  }

  block.result = mapAcpToolResult(ctx.sourceToolName, block.content, ctx, !!block.is_error) as unknown as {
    kind: string
    [k: string]: unknown
  }
}

export function mapAcpToolUse(
  name: string,
  input: Record<string, unknown>,
): { kind: ToolKind; canonicalInput: Record<string, unknown> } {
  const r = (kind: ToolKind, canonical: object) => ({
    kind,
    canonicalInput: canonical as Record<string, unknown>,
  })
  switch (name.toLowerCase()) {
    case 'read':
      return r('file.read', acpReadInput(input))
    case 'write':
      return r('file.write', acpWriteInput(input))
    case 'edit':
      return r('file.edit', acpEditInput(input))
    case 'glob':
      return r('file.glob', acpGlobInput(input))
    case 'grep':
      return r('text.search', acpGrepInput(input))
    case 'bash':
    case 'shell':
      return r('shell.exec', acpBashInput(input))
    case 'task':
    case 'agent':
      return r('task.spawn', acpTaskInput(input))
    case 'todowrite':
    case 'todo_write':
      return r('todo.write', acpTodoInput(input))
    case 'webfetch':
    case 'web_fetch':
      return r('web.fetch', acpWebFetchInput(input))
    case 'websearch':
    case 'web_search':
      return r('web.search', acpWebSearchInput(input))
    default: {
      // ACP MCP names from opencode/codex use `<server>_<tool>` -- if the
      // first underscore-delimited prefix matches a known MCP server, route
      // to the MCP namespace. This is intentionally conservative: tools
      // without a known prefix fall through to agent.unknown.
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

function acpReadInput(input: Record<string, unknown>): FileReadInput {
  const out: FileReadInput = { path: stringOr(input.filePath ?? input.file_path, '') }
  if (typeof input.offset === 'number') out.offset = input.offset
  if (typeof input.limit === 'number') out.limit = input.limit
  return out
}

function acpWriteInput(input: Record<string, unknown>): FileWriteInput {
  return {
    path: stringOr(input.filePath ?? input.file_path, ''),
    content: stringOr(input.content, ''),
  }
}

function acpEditInput(input: Record<string, unknown>): FileEditInput {
  const out: FileEditInput = {
    path: stringOr(input.filePath ?? input.file_path, ''),
    oldText: stringOr(input.oldString ?? input.old_string, ''),
    newText: stringOr(input.newString ?? input.new_string, ''),
  }
  if (typeof input.replaceAll === 'boolean') out.replaceAll = input.replaceAll
  else if (typeof input.replace_all === 'boolean') out.replaceAll = input.replace_all
  return out
}

function acpGlobInput(input: Record<string, unknown>): FileGlobInput {
  const out: FileGlobInput = { pattern: stringOr(input.pattern, '') }
  if (typeof input.path === 'string') out.cwd = input.path
  return out
}

function acpGrepInput(input: Record<string, unknown>): TextSearchInput {
  const out: TextSearchInput = { pattern: stringOr(input.pattern, '') }
  if (typeof input.path === 'string') out.path = input.path
  // opencode uses `include` instead of `glob`
  const glob = input.glob ?? input.include
  if (typeof glob === 'string') out.glob = glob
  if (typeof input.caseInsensitive === 'boolean') out.caseInsensitive = input.caseInsensitive
  if (typeof input.contextLines === 'number') out.contextLines = input.contextLines
  if (typeof input.outputMode === 'string') out.outputMode = input.outputMode
  if (typeof input.headLimit === 'number') out.headLimit = input.headLimit
  return out
}

function acpBashInput(input: Record<string, unknown>): ShellExecInput {
  const out: ShellExecInput = { command: stringOr(input.command, '') }
  if (typeof input.description === 'string') out.description = input.description
  if (typeof input.workdir === 'string') out.cwd = input.workdir
  else if (typeof input.cwd === 'string') out.cwd = input.cwd
  if (typeof input.timeout === 'number') out.timeoutMs = input.timeout
  if (typeof input.timeoutMs === 'number') out.timeoutMs = input.timeoutMs
  if (typeof input.runInBackground === 'boolean') out.runInBackground = input.runInBackground
  return out
}

function acpTaskInput(input: Record<string, unknown>): TaskSpawnInput {
  return {
    agent: stringOr(input.subagent_type ?? input.agent ?? input.subagentType, ''),
    prompt: stringOr(input.prompt, ''),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
  }
}

function acpTodoInput(input: Record<string, unknown>): TodoWriteInput {
  // opencode todos: { content, priority, status } (no activeForm).
  // Claude todos via ACP: { content, status, activeForm }. Both pass through
  // since TodoWriteInput.todos uses an open shape.
  const todos = Array.isArray(input.todos) ? (input.todos as TodoWriteInput['todos']) : []
  return { todos }
}

function acpWebFetchInput(input: Record<string, unknown>): WebFetchInput {
  return {
    url: stringOr(input.url, ''),
    ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
  }
}

function acpWebSearchInput(input: Record<string, unknown>): WebSearchInput {
  const out: WebSearchInput = { query: stringOr(input.query, '') }
  if (Array.isArray(input.allowedDomains)) out.allowedDomains = input.allowedDomains as string[]
  else if (Array.isArray(input.allowed_domains)) out.allowedDomains = input.allowed_domains as string[]
  if (Array.isArray(input.blockedDomains)) out.blockedDomains = input.blockedDomains as string[]
  else if (Array.isArray(input.blocked_domains)) out.blockedDomains = input.blocked_domains as string[]
  return out
}

function normalizeMcpServerName(server: string): string {
  if (server === 'rclaude' || server === 'claudwerk') return 'claudewerk'
  return server
}

// ---------------------------------------------------------------------------
// result mapping
// ---------------------------------------------------------------------------

function mapAcpToolResult(
  sourceTool: string,
  content: unknown,
  ctx: AcpToolResultContext,
  isError: boolean,
): ToolResult {
  if (isError) {
    return { kind: 'error', message: stringifyContent(content) || 'Tool error' }
  }

  switch (sourceTool.toLowerCase()) {
    case 'bash':
    case 'shell':
      return mapAcpBashResult(content, ctx)
    case 'read':
      return mapAcpReadResult(content, ctx)
    case 'write':
    case 'edit':
      return { kind: 'text', text: stringifyContent(content) }
    default: {
      const text = stringifyContent(content)
      if (text) return { kind: 'text', text }
      return { kind: 'unknown', payload: ctx.rawOutput ?? content }
    }
  }
}

function mapAcpBashResult(content: unknown, ctx: AcpToolResultContext): ToolResult {
  const stdout = stringifyContent(content)
  const exit = ctx.metadata?.exit
  const truncated = ctx.metadata?.truncated === true
  const durationMs = ctx.metadata?.durationMs
  return {
    kind: 'shell',
    stdout,
    ...(typeof exit === 'number' ? { exitCode: exit } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
  }
}

/** opencode wraps file reads as
 *    <path>/etc/hosts</path>\n<type>file</type>\n<content>\n1: ...\n</content>
 *  Parse it out into a canonical file envelope. Falls back to text envelope
 *  if no wrapper is present (codex/gemini etc.). */
function mapAcpReadResult(content: unknown, _ctx: AcpToolResultContext): ToolResult {
  const text = stringifyContent(content)
  const parsed = parseAcpReadWrapper(text)
  if (parsed) {
    return {
      kind: 'file',
      mediaType: parsed.mediaType,
      text: parsed.text,
    }
  }
  return { kind: 'text', text }
}

export function parseAcpReadWrapper(text: string): { mediaType: string; text: string } | null {
  const pathMatch = text.match(/^<path>([\s\S]*?)<\/path>/)
  const typeMatch = text.match(/<type>([\s\S]*?)<\/type>/)
  const contentMatch = text.match(/<content>\n?([\s\S]*?)\n?<\/content>/)
  if (!pathMatch || !contentMatch) return null
  const ext = pathMatch[1].split('.').pop()?.toLowerCase() ?? ''
  const fileType = typeMatch?.[1]?.toLowerCase() ?? 'file'
  const mediaType = mediaTypeFor(fileType, ext)
  return { mediaType, text: contentMatch[1] }
}

function mediaTypeFor(fileType: string, ext: string): string {
  if (fileType === 'image') {
    switch (ext) {
      case 'png':
        return 'image/png'
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg'
      case 'gif':
        return 'image/gif'
      case 'webp':
        return 'image/webp'
      default:
        return 'image/' + (ext || 'octet-stream')
    }
  }
  if (ext === 'json') return 'application/json'
  if (ext === 'md' || ext === 'markdown') return 'text/markdown'
  if (ext === 'html' || ext === 'htm') return 'text/html'
  return 'text/plain'
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
