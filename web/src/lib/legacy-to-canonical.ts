/**
 * Legacy-to-canonical shim.
 *
 * Pre-Phase-2 transcript entries (and any agent host that hasn't shipped
 * the dialect translator yet) carry only the LEGACY Claude-API fields:
 * `name` + `input` for tool_use, `content` + `is_error` for tool_result.
 * The dashboard's canonical dispatch keys on `kind` + `canonicalInput`,
 * which those entries lack.
 *
 * `ensureCanonical(block)` synthesizes the canonical fields in place so
 * downstream renderers see a uniform shape regardless of when the entry
 * was emitted. Idempotent: blocks that already have `kind` (i.e. came
 * through a translator on the agent host side) pass through untouched.
 *
 * Origin: the toxic-mammoth ACP/opencode session
 * (54831a0a-2461-479e-94b1-34968ee26164) rendered as raw JSON because
 * tool names were lowercase (`read` vs `Read`) and input keys were
 * camelCase (`filePath` vs `file_path`). Phase 2 translators handle
 * NEW emissions; this shim retrofits OLD persisted entries so they
 * render correctly without a DB migration.
 */

import type { TranscriptContentBlock } from '@/lib/types'

interface CanonicalSlice {
  kind: string
  canonicalInput: Record<string, unknown>
}

/** Mutate `block` to add `kind` + `canonicalInput` if missing. Idempotent.
 *  Safe to call on non-tool blocks (no-op). Returns the same reference. */
export function ensureCanonical(block: TranscriptContentBlock): TranscriptContentBlock {
  if (block.type === 'tool_use') {
    if (block.kind && block.canonicalInput) return block
    const { kind, canonicalInput } = canonicalizeToolUse(
      block.name ?? '',
      (block.input ?? {}) as Record<string, unknown>,
    )
    if (!block.kind) block.kind = kind
    if (!block.canonicalInput) block.canonicalInput = canonicalInput
  }
  return block
}

/** Pure helper exposed for tests. Maps a (legacy) tool name + input dict
 *  to the best-guess canonical kind + canonicalInput. Handles the three
 *  dialects the broker has persisted entries for:
 *
 *  - Claude:   PascalCase names (Read, Write, Edit, ...) + snake_case input
 *  - ACP:      lowercase names (read, write, edit, ...) + camelCase input
 *  - opencode: lowercase names + camelCase input (same as ACP)
 *
 *  Tool names match case-insensitively to admit either dialect. Input
 *  keys are read with both shapes (file_path OR filePath, etc.). */
export function canonicalizeToolUse(name: string, input: Record<string, unknown>): CanonicalSlice {
  const lower = name.toLowerCase()
  const v = (...keys: string[]) => firstString(input, keys)
  const n = (...keys: string[]) => firstNumber(input, keys)
  const b = (...keys: string[]) => firstBoolean(input, keys)

  switch (lower) {
    case 'read':
      return mk('file.read', {
        path: v('file_path', 'filePath') ?? '',
        ...(n('offset') !== undefined ? { offset: n('offset') } : {}),
        ...(n('limit') !== undefined ? { limit: n('limit') } : {}),
      })
    case 'write':
      return mk('file.write', {
        path: v('file_path', 'filePath') ?? '',
        content: v('content') ?? '',
      })
    case 'edit':
    case 'multiedit':
      return mk('file.edit', {
        path: v('file_path', 'filePath') ?? '',
        oldText: v('old_string', 'oldString') ?? '',
        newText: v('new_string', 'newString') ?? '',
        ...(b('replace_all', 'replaceAll') !== undefined ? { replaceAll: b('replace_all', 'replaceAll') } : {}),
      })
    case 'glob':
      return mk('file.glob', {
        pattern: v('pattern') ?? '',
        ...(v('path') !== undefined ? { cwd: v('path') } : {}),
      })
    case 'grep':
      return mk('text.search', {
        pattern: v('pattern') ?? '',
        ...(v('path') !== undefined ? { path: v('path') } : {}),
        ...(v('glob', 'include') !== undefined ? { glob: v('glob', 'include') } : {}),
        ...(b('-i', 'caseInsensitive') !== undefined ? { caseInsensitive: b('-i', 'caseInsensitive') } : {}),
        ...(n('-C', 'contextLines') !== undefined ? { contextLines: n('-C', 'contextLines') } : {}),
        ...(v('output_mode', 'outputMode') !== undefined ? { outputMode: v('output_mode', 'outputMode') } : {}),
        ...(n('head_limit', 'headLimit') !== undefined ? { headLimit: n('head_limit', 'headLimit') } : {}),
      })
    case 'bash':
    case 'bashoutput':
    case 'shell':
      return mk('shell.exec', {
        command: v('command') ?? '',
        ...(v('description') !== undefined ? { description: v('description') } : {}),
        ...(v('cwd', 'workdir') !== undefined ? { cwd: v('cwd', 'workdir') } : {}),
        ...(n('timeout', 'timeoutMs') !== undefined ? { timeoutMs: n('timeout', 'timeoutMs') } : {}),
        ...(b('run_in_background', 'runInBackground') !== undefined
          ? { runInBackground: b('run_in_background', 'runInBackground') }
          : {}),
      })
    case 'task':
    case 'agent':
      return mk('task.spawn', {
        agent: v('subagent_type', 'agent', 'subagentType') ?? '',
        prompt: v('prompt') ?? '',
        ...(v('description') !== undefined ? { description: v('description') } : {}),
      })
    case 'todowrite':
    case 'todo_write':
      return mk('todo.write', {
        todos: Array.isArray(input.todos) ? input.todos : [],
      })
    case 'webfetch':
    case 'web_fetch':
      return mk('web.fetch', {
        url: v('url') ?? '',
        ...(v('prompt') !== undefined ? { prompt: v('prompt') } : {}),
      })
    case 'websearch':
    case 'web_search':
      return mk('web.search', {
        query: v('query') ?? '',
        ...(Array.isArray(input.allowed_domains) ? { allowedDomains: input.allowed_domains } : {}),
        ...(Array.isArray(input.allowedDomains) ? { allowedDomains: input.allowedDomains } : {}),
        ...(Array.isArray(input.blocked_domains) ? { blockedDomains: input.blocked_domains } : {}),
        ...(Array.isArray(input.blockedDomains) ? { blockedDomains: input.blockedDomains } : {}),
      })
    case 'notebookedit':
      return mk('notebook.edit', {
        path: v('notebook_path', 'notebookPath') ?? '',
        ...(v('cell_id', 'cellId') !== undefined ? { cellId: v('cell_id', 'cellId') } : {}),
        ...(v('new_source', 'newSource') !== undefined ? { newSource: v('new_source', 'newSource') } : {}),
        ...(v('cell_type', 'cellType') !== undefined ? { cellType: v('cell_type', 'cellType') } : {}),
        ...(v('edit_mode', 'editMode') !== undefined ? { editMode: v('edit_mode', 'editMode') } : {}),
      })
    case 'repl':
      return mk('repl.exec', {
        code: v('code') ?? '',
        ...(v('description') !== undefined ? { description: v('description') } : {}),
      })
    default: {
      // Claude MCP names: mcp__<server>__<tool>
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        if (parts.length >= 3) {
          const server = normalizeMcpServer(parts[1])
          const tool = parts.slice(2).join('__')
          return mk(`mcp.${server}.${tool}`, { ...input })
        }
      }
      // ACP/opencode MCP names: <server>_<tool>. Only route the brand
      // namespace so we don't false-positive on grep/bash with underscores.
      if (name.includes('_')) {
        const idx = name.indexOf('_')
        const server = normalizeMcpServer(name.slice(0, idx))
        const tool = name.slice(idx + 1)
        if (server === 'claudewerk') {
          return mk(`mcp.${server}.${tool}`, { ...input })
        }
      }
      return mk('agent.unknown', { ...input })
    }
  }
}

function mk(kind: string, canonicalInput: Record<string, unknown>): CanonicalSlice {
  return { kind, canonicalInput }
}

function normalizeMcpServer(server: string): string {
  if (server === 'rclaude' || server === 'claudwerk') return 'claudewerk'
  return server
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string') return v
  }
  return undefined
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number') return v
  }
  return undefined
}

function firstBoolean(obj: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'boolean') return v
  }
  return undefined
}
