/**
 * CLAUDEWERK canonical tool vocabulary.
 *
 * Backend-agnostic tool kinds + input/result shapes that every agent host
 * translates ITS native dialect into. The wire protocol carries:
 *
 *   tool_use   -> { kind, input (canonical), raw (origin), name (legacy alias) }
 *   tool_result -> { result.kind + canonical fields, raw (origin), content (legacy) }
 *
 * The `raw` field is REQUIRED on every new emission. The original backend
 * payload is never lost -- it always rides along for inspection.
 *
 * See `.claude/docs/plan-fabric.md` and the dialect-translation work plan
 * for the full rationale.
 */

/** Canonical tool kinds. Namespaced verb-shaped identifiers.
 *
 *  Adding a new kind:
 *  1. Add the constant here.
 *  2. Add an input interface to `ToolKindInputs` below.
 *  3. Add a display-name mapping in `displayNameFor()`.
 *  4. Update each per-backend translator to map its native tool to this kind.
 */
export const TOOL_KINDS = {
  /** Read a file. */
  FileRead: 'file.read',
  /** Write/overwrite a file. */
  FileWrite: 'file.write',
  /** Apply an edit (find + replace OR full rewrite) to a file. */
  FileEdit: 'file.edit',
  /** List files matching a glob pattern. */
  FileGlob: 'file.glob',
  /** Search file contents (grep / ripgrep). */
  TextSearch: 'text.search',
  /** Run a shell command. */
  ShellExec: 'shell.exec',
  /** Spawn a sub-agent / sub-task. */
  TaskSpawn: 'task.spawn',
  /** Write a todo list (kanban-ish state). */
  TodoWrite: 'todo.write',
  /** Fetch a URL (HTTP GET / page render). */
  WebFetch: 'web.fetch',
  /** Free-text web search. */
  WebSearch: 'web.search',
  /** Edit a Jupyter notebook cell. */
  NotebookEdit: 'notebook.edit',
  /** Run code in a REPL / sandbox. */
  ReplExec: 'repl.exec',
  /** MCP tools are namespaced as `mcp.<server>.<tool>`. The string is built,
   *  not constant -- this is a marker for the prefix only. */
  McpPrefix: 'mcp.',
  /** Fallback for anything we don't yet have a canonical mapping for. The
   *  raw payload is the only useful thing in this case. */
  AgentUnknown: 'agent.unknown',
} as const

export type ToolKind = (typeof TOOL_KINDS)[keyof typeof TOOL_KINDS] | (string & {})

// ---------------------------------------------------------------------------
// Canonical input shapes (per kind).
// These are advisory: the wire carries `Record<string, unknown>`. Translators
// SHOULD produce these shapes; renderers SHOULD assume them. Use the type
// guards / accessors to read with safety.
// ---------------------------------------------------------------------------

export interface FileReadInput {
  path: string
  /** 0-indexed line offset. */
  offset?: number
  /** Max number of lines to read. */
  limit?: number
}

export interface FileWriteInput {
  path: string
  content: string
}

export interface FileEditInput {
  path: string
  /** Empty string means "create from scratch" / "full rewrite". */
  oldText: string
  newText: string
  /** Replace all occurrences instead of just the first. */
  replaceAll?: boolean
}

export interface FileGlobInput {
  pattern: string
  cwd?: string
}

export interface TextSearchInput {
  pattern: string
  /** Restrict to a path or glob. */
  path?: string
  glob?: string
  /** Case-insensitive. */
  caseInsensitive?: boolean
  /** Context lines around each match. */
  contextLines?: number
  /** 'content' | 'files_with_matches' | 'count'. */
  outputMode?: string
  headLimit?: number
}

export interface ShellExecInput {
  command: string
  cwd?: string
  description?: string
  timeoutMs?: number
  runInBackground?: boolean
}

export interface TaskSpawnInput {
  /** The agent type / sub-agent name to spawn. */
  agent: string
  /** The prompt / task description for the sub-agent. */
  prompt: string
  /** Short human-readable label. */
  description?: string
}

export interface TodoWriteInput {
  todos: Array<{
    content: string
    status?: 'pending' | 'in_progress' | 'completed' | 'cancelled' | (string & {})
    activeForm?: string
    [k: string]: unknown
  }>
}

export interface WebFetchInput {
  url: string
  prompt?: string
}

export interface WebSearchInput {
  query: string
  allowedDomains?: string[]
  blockedDomains?: string[]
}

export interface NotebookEditInput {
  path: string
  cellId?: string
  newSource?: string
  cellType?: string
  editMode?: string
}

export interface ReplExecInput {
  code: string
  description?: string
}

/** Type-level map from kind to its canonical input shape. */
export interface ToolKindInputs {
  'file.read': FileReadInput
  'file.write': FileWriteInput
  'file.edit': FileEditInput
  'file.glob': FileGlobInput
  'text.search': TextSearchInput
  'shell.exec': ShellExecInput
  'task.spawn': TaskSpawnInput
  'todo.write': TodoWriteInput
  'web.fetch': WebFetchInput
  'web.search': WebSearchInput
  'notebook.edit': NotebookEditInput
  'repl.exec': ReplExecInput
  'agent.unknown': Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Canonical result envelopes.
// ---------------------------------------------------------------------------

export type ToolResultKind = 'text' | 'shell' | 'file' | 'error' | 'unknown' | (string & {})

export interface ToolResultText {
  kind: 'text'
  text: string
}

export interface ToolResultShell {
  kind: 'shell'
  stdout: string
  stderr?: string
  exitCode?: number
  truncated?: boolean
  durationMs?: number
}

export interface ToolResultFile {
  kind: 'file'
  /** MIME type, e.g. 'image/png', 'application/pdf', 'text/plain'. */
  mediaType: string
  /** Raw text content (for textual files). */
  text?: string
  /** URL to retrieve binary content. */
  url?: string
  /** Original byte size on disk. */
  bytes?: number
  /** For images. */
  dimensions?: { width: number; height: number }
}

export interface ToolResultError {
  kind: 'error'
  message: string
  code?: string
}

export interface ToolResultUnknown {
  kind: 'unknown'
  /** Verbatim payload from the backend, untranslated. */
  payload: unknown
}

export type ToolResult = ToolResultText | ToolResultShell | ToolResultFile | ToolResultError | ToolResultUnknown

// ---------------------------------------------------------------------------
// Origin (preserved on every translated tool block).
// ---------------------------------------------------------------------------

/** Backend identifier. String union for the known backends; `string` escape
 *  hatch lets new backends slot in without a protocol bump. Compound form
 *  `acp:<agent>` is used when a backend is itself a protocol multiplexing
 *  several agents (e.g. ACP hosting opencode, codex, gemini-acp). */
export type ToolBackend =
  | 'claude'
  | 'opencode'
  | 'acp:opencode'
  | 'acp:codex'
  | 'acp:gemini'
  | 'acp:claude'
  | (string & {})

/** Origin payload preserved for inspection. NEVER lost in translation. */
export interface ToolOrigin {
  backend: ToolBackend
  /** Raw tool name as delivered by the backend (e.g. 'edit', 'Edit', 'fs_edit'). */
  name: string
  /** Raw input payload, byte-for-byte from the backend. */
  input: unknown
}

export interface ToolResultOrigin {
  backend: ToolBackend
  /** Raw result payload, byte-for-byte from the backend. */
  content: unknown
  /** Raw `is_error` / failure flag, if the backend supplied one. */
  isError?: boolean
}

// ---------------------------------------------------------------------------
// Display helpers.
// ---------------------------------------------------------------------------

/** Map a canonical kind to a human-readable display name. Used to populate
 *  the legacy `name` field on tool_use blocks for backward-compat with any
 *  reader that still keys on it. */
export function displayNameFor(kind: ToolKind): string {
  switch (kind) {
    case 'file.read':
      return 'Read'
    case 'file.write':
      return 'Write'
    case 'file.edit':
      return 'Edit'
    case 'file.glob':
      return 'Glob'
    case 'text.search':
      return 'Grep'
    case 'shell.exec':
      return 'Bash'
    case 'task.spawn':
      return 'Task'
    case 'todo.write':
      return 'TodoWrite'
    case 'web.fetch':
      return 'WebFetch'
    case 'web.search':
      return 'WebSearch'
    case 'notebook.edit':
      return 'NotebookEdit'
    case 'repl.exec':
      return 'REPL'
    case 'agent.unknown':
      return 'tool'
    default:
      // mcp.<server>.<tool> -> show as "<tool>" or fall back to the full kind
      if (kind.startsWith('mcp.')) {
        const parts = kind.split('.')
        return parts[parts.length - 1] || kind
      }
      return kind
  }
}

/** Build an MCP-namespaced canonical kind. */
export function mcpKind(server: string, tool: string): string {
  return `mcp.${server}.${tool}`
}

/** Test whether a kind is in the MCP namespace. */
export function isMcpKind(kind: string): boolean {
  return kind.startsWith('mcp.')
}
