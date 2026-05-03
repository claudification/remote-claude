/**
 * MCP Channel Server for rclaude
 *
 * Implements a Claude Code Channel via MCP Streamable HTTP transport.
 * Claude Code connects to this server and receives dashboard input
 * as channel notifications instead of PTY keystroke injection.
 *
 * Architecture:
 *   Dashboard -> broker WS -> rclaude -> mcp.notification()
 *   -> SSE stream -> Claude Code sees <channel source="rclaude">message</channel>
 *
 * Two-way: Claude calls mcp tools (reply, notify) -> rclaude -> broker -> dashboard
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { DialogLayout, DialogResult } from '../shared/dialog-schema'
import { dialogToolInputSchema, validateDialogLayout } from '../shared/dialog-schema'
import { isPathWithinCwd } from '../shared/path-guard'
import { type SpawnRequest, spawnRequestSchema } from '../shared/spawn-schema'
import { DEFAULT_VISIBLE_STATUSES, TASK_STATUSES, type TaskStatus } from '../shared/task-statuses'
import { checkForUpdate, formatUpdateResult } from '../shared/update-check'
import { BUILD_VERSION } from '../shared/version'
import { debug } from './debug'
import { moveProjectTask } from './project-tasks'

const DIALOG_LOG = '/tmp/rclaude-dialog.log'

function formatStatus(s: string): string {
  return s
    .split('-')
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('-')
}

/** Always-on dialog logging (not gated by RCLAUDE_DEBUG) */
function elog(msg: string): void {
  try {
    appendFileSync(DIALOG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* ignore */
  }
  debug(`[dialog] ${msg}`)
}

export interface ConversationInfo {
  id: string // addressable ID: bare project slug or compound "project:session-name"
  project: string // project URI (e.g. "claude:///Users/jonas/projects/foo")
  session_id?: string // CC session ID (for transcript/task context)
  name: string
  status: 'live' | 'inactive'
  ccSessionIds?: string[] // only present when multiple wrappers share a session
  label?: string
  description?: string
  title?: string
  summary?: string
}

export interface AgentHostIdentity {
  ccSessionId: string
  conversationId: string
  cwd: string
  configuredModel?: string
  headless: boolean
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
}

export interface PermissionRequestData {
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

export interface McpChannelCallbacks {
  onNotify?: (message: string, title?: string) => void
  onShareFile?: (filePath: string) => Promise<string | null>
  onListConversations?: (
    status?: string,
    showMetadata?: boolean,
  ) => Promise<{ sessions: ConversationInfo[]; self?: Record<string, unknown> }>
  onSendMessage?: (
    to: string,
    intent: string,
    message: string,
    context?: string,
    conversationId?: string,
  ) => Promise<{ ok: boolean; error?: string; conversationId?: string; targetSessionId?: string }>
  onPermissionRequest?: (data: PermissionRequestData) => void
  onDisconnect?: () => void
  onTogglePlanMode?: () => void
  onReviveConversation?: (conversationId: string) => Promise<{ ok: boolean; error?: string; name?: string }>
  /**
   * Unified session control: clear | quit | interrupt | set_model | set_effort.
   * Dashboards and the MCP `control_session` tool both route through here. The
   * wrapper forwards to the target via WS `session_control` and the broker
   * routes to the target's wrapper for backend-specific dispatch.
   */
  onControlSession?: (params: {
    conversationId: string
    action: 'clear' | 'quit' | 'interrupt' | 'set_model' | 'set_effort' | 'set_permission_mode'
    model?: string
    effort?: string
    permissionMode?: string
  }) => Promise<{ ok: boolean; error?: string; name?: string }>
  onRestartConversation?: (conversationId: string) => Promise<{
    ok: boolean
    error?: string
    name?: string
    selfRestart?: boolean
    alreadyEnded?: boolean
  }>
  onSpawnConversation?: (
    params: Omit<SpawnRequest, 'jobId'> & {
      onProgress?: (event: Record<string, unknown>) => void
    },
  ) => Promise<{ ok: boolean; error?: string; conversationId?: string; jobId?: string }>
  onListHosts?: () => Promise<Array<{ alias: string; hostname?: string; connected: boolean; sessionCount: number }>>
  onGetSpawnDiagnostics?: (
    jobId: string,
  ) => Promise<{ ok: boolean; error?: string; diagnostics?: Record<string, unknown> }>
  onConfigureConversation?: (params: {
    conversationId: string
    label?: string
    icon?: string
    color?: string
    description?: string
    keyterms?: string[]
  }) => Promise<{ ok: boolean; error?: string }>
  onDialogShow?: (dialogId: string, layout: DialogLayout) => void
  onDialogDismiss?: (dialogId: string) => void
  /** Deliver a message to Claude (channel notification in PTY, stdin user message in headless) */
  onDeliverMessage?: (content: string, meta: Record<string, string>) => void
  /** Rename the current session */
  onRenameConversation?: (name: string, description?: string) => Promise<{ ok: boolean; error?: string }>
  /** Notify that project tasks changed (triggers project_changed broadcast to dashboard) */
  onProjectChanged?: () => void
  /** Self-terminate this session */
  onExitConversation?: (status: 'success' | 'error', message?: string) => void
}

interface McpChannelState {
  mcpServer: McpServer
  transport: WebStandardStreamableHTTPServerTransport
  connected: boolean
}

let state: McpChannelState | null = null
let callbacks: McpChannelCallbacks = {}
let identity: AgentHostIdentity | null = null
let keepaliveTimer: ReturnType<typeof setInterval> | null = null
let claudeCodeVersion: string | undefined

// ─── Pending Dialog state ──────────────────────────────────────────
interface PendingDialog {
  resolve: (result: DialogResult) => void
  timer: ReturnType<typeof setTimeout>
  timeoutMs: number // initial timeout duration
  deadline: number // Date.now() + timeoutMs
}
const pendingDialogs = new Map<string, PendingDialog>()

/** Module-level CWD for file resolution in dialog */
let dialogCwd = process.cwd()

/** Set the CWD used for resolving relative paths in dialog layouts */
export function setDialogCwd(cwd: string): void {
  dialogCwd = cwd
}

function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://')
}

/**
 * Walk a dialog layout and upload any local file paths (Image.url, ImagePicker.images[].url).
 * Returns an error message if any file doesn't exist or fails to upload, null on success.
 * Mutates the layout in place, replacing file paths with uploaded URLs.
 */
async function resolveDialogFiles(
  components: Array<Record<string, unknown>>,
  uploadFile: (path: string) => Promise<string | null>,
  cwd: string,
): Promise<string | null> {
  for (const comp of components) {
    try {
      const type = comp.type as string

      // Markdown: resolve file prop -> inline content (CWD-jailed)
      if (type === 'Markdown' && typeof comp.file === 'string' && !comp.content) {
        const filePath = comp.file as string
        const absPath = resolvePath(cwd, filePath)
        if (!isPathWithinCwd(absPath, cwd)) {
          return `Markdown file outside project directory: ${filePath}. Move it into ${cwd} first.`
        }
        try {
          const file = Bun.file(absPath)
          if (!(await file.exists())) {
            return `Markdown file not found: ${filePath} (resolved to ${absPath})`
          }
          comp.content = await file.text()
          delete comp.file
          elog(`inlined file: ${filePath} (${(comp.content as string).length} chars)`)
        } catch (err) {
          return `Markdown file not readable: ${filePath} (${err instanceof Error ? err.message : 'unknown'})`
        }
      }

      if (type === 'Image' && typeof comp.url === 'string' && !isUrl(comp.url)) {
        const absPath = resolvePath(cwd, comp.url)
        if (!isPathWithinCwd(absPath, cwd)) {
          return `Image file outside project directory: ${comp.url}. Move it into ${cwd} first.`
        }
        try {
          const file = Bun.file(absPath)
          if (!(await file.exists())) {
            return `Image file not found: ${comp.url} (resolved to ${absPath})`
          }
        } catch {
          return `Image file not accessible: ${comp.url} (resolved to ${absPath})`
        }
        const url = await uploadFile(absPath)
        if (!url) return `Failed to upload image: ${comp.url}`
        comp.url = url
      }

      if (type === 'ImagePicker' && Array.isArray(comp.images)) {
        for (const img of comp.images as Array<Record<string, unknown>>) {
          if (typeof img.url === 'string' && !isUrl(img.url)) {
            const absPath = resolvePath(cwd, img.url)
            if (!isPathWithinCwd(absPath, cwd)) {
              return `ImagePicker file outside project directory: ${img.url}. Move it into ${cwd} first.`
            }
            try {
              const file = Bun.file(absPath)
              if (!(await file.exists())) {
                return `ImagePicker file not found: ${img.url} (resolved to ${absPath})`
              }
            } catch {
              return `ImagePicker file not accessible: ${img.url} (resolved to ${absPath})`
            }
            const url = await uploadFile(absPath)
            if (!url) return `Failed to upload image: ${img.url}`
            img.url = url
          }
        }
      }

      // Recurse into layout children
      if (Array.isArray(comp.children)) {
        const err = await resolveDialogFiles(comp.children as Array<Record<string, unknown>>, uploadFile, cwd)
        if (err) return err
      }
    } catch (err) {
      elog(`resolveDialogFiles error: ${err instanceof Error ? err.message : err}`)
      return `File resolution error: ${err instanceof Error ? err.message : 'unknown'}`
    }
  }
  return null
}

/** Resolve a pending dialog with the user's result (called from WS handler).
 * Delivers result via onDeliverMessage callback -- transport-agnostic. */
export function resolveDialog(dialogId: string, result: DialogResult): boolean {
  const pending = pendingDialogs.get(dialogId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingDialogs.delete(dialogId)

  const meta: Record<string, string> = {
    sender: 'dialog',
    dialog_id: dialogId,
  }

  if (result._timeout) {
    meta.status = 'timeout'
    callbacks.onDeliverMessage?.('Dialog timed out - user did not respond.', meta)
  } else if (result._cancelled) {
    meta.status = 'cancelled'
    callbacks.onDeliverMessage?.('User cancelled the dialog.', meta)
  } else {
    meta.status = 'submitted'
    if (result._action && result._action !== 'submit') meta.action = result._action as string
    const userValues: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(result)) {
      if (!k.startsWith('_')) userValues[k] = v
    }
    callbacks.onDeliverMessage?.(JSON.stringify(userValues, null, 2), meta)
  }
  callbacks.onDialogDismiss?.(dialogId)
  return true
}

/** Extend dialog timeout on user interaction (called from WS handler) */
export function keepaliveDialog(dialogId: string): boolean {
  const pending = pendingDialogs.get(dialogId)
  if (!pending) return false

  const minRemaining = pending.timeoutMs * 0.5
  const remaining = pending.deadline - Date.now()

  if (remaining < minRemaining) {
    // Extend to at least 50% of original timeout
    clearTimeout(pending.timer)
    const newDeadline = Date.now() + minRemaining
    pending.deadline = newDeadline
    pending.timer = setTimeout(() => {
      pendingDialogs.delete(dialogId)
      callbacks.onDeliverMessage?.('Dialog timed out - user did not respond.', {
        sender: 'dialog',
        dialog_id: dialogId,
        status: 'timeout',
      })
      callbacks.onDialogDismiss?.(dialogId)
    }, minRemaining)
    elog(`keepalive: ${dialogId.slice(0, 8)} extended to ${Math.round(minRemaining / 1000)}s`)
  }
  return true
}

/**
 * Initialize the MCP channel server.
 * Call once on startup. The transport handles HTTP requests via handleMcpRequest().
 */
export function initMcpChannel(cb: McpChannelCallbacks, id?: AgentHostIdentity): void {
  callbacks = cb
  if (id) identity = id

  const mcpServer = new McpServer(
    { name: 'rclaude', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        logging: {},
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
      },
    },
  )
  const server = mcpServer.server // low-level access for custom handlers

  // spawn_session input schema: shared spawn fields + MCP-specific (action, session_id, resume_id alias).
  // cwd is only required for action=spawn; make it optional at schema level and validate in handler.
  const spawnToolSchema = spawnRequestSchema
    .omit({ jobId: true })
    .extend({
      action: z
        .enum(['spawn', 'revive', 'restart'])
        .optional()
        .describe(
          'Action to perform. "spawn" = new session at cwd, "revive" = bring back an ended session, "restart" = terminate + auto-revive. Default: spawn.',
        ),
      session_id: z
        .string()
        .optional()
        .describe('Target session ID from list_sessions. Required for revive and restart actions.'),
      resume_id: z.string().optional().describe('Claude Code session ID to resume (alias for resumeId).'),
      host: z.string().optional().describe('Target sentinel alias (from list_hosts). Maps to sentinel field.'),
    })
    .partial({ cwd: true })
  const spawnToolInputSchema = z.toJSONSchema(spawnToolSchema) as {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }

  // ─── Tool registry ────────────────────────────────────────────────
  // Each entry colocates schema + handler. The two request handlers below
  // derive the tools list and dispatch table from this single source.

  type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
  interface ToolCtx {
    progressToken?: string | number
    rawArgs: unknown
    // extra is the SDK RequestHandlerExtra passed through for tools that need it (e.g. spawn_session progress)
    extra: unknown
  }
  interface ToolDef {
    description: string
    inputSchema: unknown
    /** If true, omit from ListTools response (legacy/alias tools still handled by CallTool) */
    hidden?: boolean
    handle: (params: Record<string, string>, ctx: ToolCtx) => Promise<ToolResult>
  }

  const tools: Record<string, ToolDef> = {
    notify: {
      description:
        "Send a push notification to the user's devices (phone, browser). Use for important alerts that need attention even when the dashboard is not in focus.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          message: { type: 'string', description: 'Notification body text' },
          title: { type: 'string', description: 'Optional notification title' },
        },
        required: ['message'],
      },
      async handle(params) {
        const message = params.message
        const title = params.title
        if (!message) return { content: [{ type: 'text', text: 'Error: message is required' }], isError: true }
        callbacks.onNotify?.(message, title)
        debug(`[channel] notify: ${message.slice(0, 80)}`)
        return { content: [{ type: 'text', text: 'Notification sent' }] }
      },
    },

    share_file: {
      description:
        'Upload a local file to the rclaude broker and get a public URL back. For images use ![description](url), for other files use [filename](url). Works for images, screenshots, build artifacts, logs, or any file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the local file to share' },
        },
        required: ['file_path'],
      },
      async handle(params) {
        const filePath = params.file_path
        if (!filePath) return { content: [{ type: 'text', text: 'Error: file_path is required' }], isError: true }
        const url = await callbacks.onShareFile?.(filePath)
        if (!url) return { content: [{ type: 'text', text: `Failed to upload ${filePath}` }], isError: true }
        debug(`[channel] share_file: ${filePath} -> ${url}`)
        return { content: [{ type: 'text', text: url }] }
      },
    },

    whoami: {
      description:
        'Returns extensive identity and environment information about the current session: session IDs, project, CWD, model, Claude Code version, rclaude version/git info, backend mode (headless/PTY), and auth context. Use this to understand your own identity within the rclaude ecosystem.',
      inputSchema: { type: 'object' as const, properties: {} },
      async handle() {
        const gitInfo = {
          hash: BUILD_VERSION.gitHash,
          hashShort: BUILD_VERSION.gitHashShort,
          branch: BUILD_VERSION.branch,
          buildTime: BUILD_VERSION.buildTime,
          dirty: BUILD_VERSION.dirty,
          repo: BUILD_VERSION.githubRepo,
          recentCommits: BUILD_VERSION.recentCommits,
        }

        const info: Record<string, unknown> = {
          ccSessionId: identity?.ccSessionId,
          conversationId: identity?.conversationId,
          cwd: identity?.cwd,
          model: identity?.configuredModel,
          backend: identity?.headless ? 'headless' : 'pty',
          claudeCodeVersion: identity?.claudeVersion || claudeCodeVersion,
          auth: identity?.claudeAuth,
          rclaude: {
            version: `rclaude/${BUILD_VERSION.gitHashShort}`,
            git: gitInfo,
          },
          platform: {
            os: process.platform,
            arch: process.arch,
            bun: Bun.version,
            pid: process.pid,
          },
        }

        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] }
      },
    },

    list_sessions: {
      description:
        'List other Claude Code sessions. Returns a stable addressable ID per session in the compound format "project:session-name" (e.g. "rclaude:fuzzy-rabbit"). The ID is always compound -- it does NOT change shape when the number of sessions at a cwd grows or shrinks. Each entry also has a "project" field showing the project-level grouping (the bare project slug, useful for grouping but only safe to use as a `to` target when exactly one session lives at that cwd). Use the returned `id` for send_message, control_session, configure_session. Messages to offline sessions are queued for delivery on reconnect. Ad-hoc sessions are hidden unless they have an established link. HINT: When the user says "tell X to Y", "ask X to Y", or "use X to Y", consider that X may be a session name -- call list_sessions to check.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['live', 'inactive', 'all'],
            description: 'Filter by status (default: live)',
          },
          filter: {
            type: 'string',
            description:
              'Optional glob pattern to filter sessions by name/label (case-insensitive). Supports * (any chars) and ? (single char). Example: "agent-*" or "*drop*".',
          },
          show_metadata: {
            type: 'boolean',
            description:
              'Include project metadata (icon, color, keyterms) in response. Only available for benevolent sessions.',
          },
        },
      },
      async handle(params) {
        const showMeta = String(params.show_metadata) === 'true'
        const result = (await callbacks.onListConversations?.(params.status, showMeta)) || { sessions: [] }
        let { sessions } = result
        const { self } = result
        if (params.filter) {
          const pattern = String(params.filter)
          const regex = new RegExp(
            '^' +
              pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*\*/g, '.*')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.') +
              '$',
            'i',
          )
          sessions = sessions.filter(
            s =>
              regex.test(s.name) ||
              (s.title && regex.test(s.title)) ||
              (s.label && regex.test(s.label)) ||
              (s.description && regex.test(s.description)),
          )
        }
        debug(
          `[channel] list_sessions: ${sessions.length} results (metadata=${showMeta}, filter=${params.filter ?? 'none'})`,
        )
        const output = self ? { self, sessions } : sessions
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] }
      },
    },

    send_message: {
      description:
        'Send a message to another Claude Code session. The `to` parameter MUST be the exact `id` field returned by `list_sessions` -- do not invent, abbreviate, or guess. The canonical form is compound "project:session-name" (e.g. "arr:blazing-igloo") and is ALWAYS accepted. A bare project slug (e.g. "arr") is also accepted ONLY when exactly one session lives at that cwd; if two or more sessions share the project, the bare form is rejected as ambiguous and the error lists the compound IDs to retry with. Always call `list_sessions` first if you are not certain. Messages to offline sessions are queued and delivered on reconnect. Returns status: "delivered" or "queued". First contact triggers an approval prompt. Include conversation_id in replies to maintain thread context.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: {
            type: 'string',
            description:
              'Target session ID. MUST be the exact `id` field from `list_sessions` output (always compound "project:session-name", e.g. "arr:blazing-igloo"). A bare project slug ("arr") is also accepted but only when one session lives at that cwd -- otherwise the resolver returns an "ambiguous" error listing the compound IDs to retry with. Do not pass the `name`, `title`, `label`, or any other field -- only `id`. When in doubt, call list_sessions first.',
          },
          intent: {
            type: 'string',
            enum: ['request', 'response', 'notify', 'progress'],
            description:
              'Message intent. Optional -- defaults to "response" when `conversation_id` is set (i.e. a reply), otherwise "request".',
          },
          message: { type: 'string', description: 'Message content' },
          context: { type: 'string', description: 'Brief context about what this relates to' },
          conversation_id: { type: 'string', description: 'Thread ID for multi-turn exchanges' },
        },
        required: ['to', 'message'],
      },
      async handle(params) {
        const { to, message, context, conversation_id } = params
        let { intent } = params
        if (!to || !message) {
          return { content: [{ type: 'text', text: 'Error: to and message are required' }], isError: true }
        }
        if (!intent) {
          intent = conversation_id ? 'response' : 'request'
          debug(`[channel] send_message: intent omitted, defaulted to "${intent}"`)
        }
        const result = await callbacks.onSendMessage?.(to, intent, message, context, conversation_id)
        if (!result?.ok) {
          debug(`[channel] send_message failed: ${result?.error}`)
          return { content: [{ type: 'text', text: result?.error || 'Failed to send message' }], isError: true }
        }
        debug(`[channel] send_message to ${to}: ${message.slice(0, 60)}`)
        const status = (result as Record<string, unknown>).status || 'delivered'
        const statusLabel = status === 'queued' ? 'Queued (target offline, will deliver on reconnect)' : 'Delivered'
        const parts = [statusLabel]
        if (result.conversationId) parts.push(`conversation_id: ${result.conversationId}`)
        if (result.targetSessionId) parts.push(`target_session_id: ${result.targetSessionId}`)
        return { content: [{ type: 'text', text: parts.join('. ') }] }
      },
    },

    toggle_plan_mode: {
      description:
        'Toggle plan mode via the terminal session. Use as a fallback when ExitPlanMode is not available. The toggle takes effect after your current response completes.',
      inputSchema: { type: 'object' as const, properties: {} },
      async handle() {
        callbacks.onTogglePlanMode?.()
        return { content: [{ type: 'text', text: 'Plan mode toggle sent via PTY.' }] }
      },
    },

    control_session: {
      description:
        "Send a high-level control verb to another session's wrapper. Unlike send_message (which delivers text to the model's context), control_session bypasses the model and tells the wrapper itself what to do. Requires benevolent trust. Actions:\n- clear: reset context (headless respawns CC fresh; PTY runs /clear in CC's CLI)\n- quit: graceful shutdown (headless closes stdin; PTY sends SIGTERM)\n- interrupt: cancel the current turn (Ctrl+C equivalent)\n- set_model: switch model (requires `model`, e.g. 'sonnet', 'opus')\n- set_effort: switch thinking-effort level (requires `effort`: low | medium | high | xhigh | max | auto)\n- set_permission_mode: switch permission mode (requires `permissionMode`: plan | acceptEdits | auto | bypassPermissions | default). Headless only -- sends set_permission_mode control_request to CC.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Target ID from list_sessions' },
          action: {
            type: 'string',
            enum: ['clear', 'quit', 'interrupt', 'set_model', 'set_effort', 'set_permission_mode'],
            description: 'Control verb to execute on the target session',
          },
          model: {
            type: 'string',
            description: 'Model name/alias (e.g. "sonnet", "opus"). Required when action is "set_model".',
          },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
            description: 'Effort level. Required when action is "set_effort". `auto` resets to model default.',
          },
          permissionMode: {
            type: 'string',
            enum: ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'],
            description: 'Permission mode. Required when action is "set_permission_mode". Headless sessions only.',
          },
        },
        required: ['session_id', 'action'],
      },
      async handle(params) {
        const targetConversationId = params.session_id
        const action = params.action as
          | 'clear'
          | 'quit'
          | 'interrupt'
          | 'set_model'
          | 'set_effort'
          | 'set_permission_mode'
        const model = typeof params.model === 'string' ? params.model : undefined
        const effort = typeof params.effort === 'string' ? params.effort : undefined
        const permissionMode = typeof params.permissionMode === 'string' ? params.permissionMode : undefined
        if (!targetConversationId)
          return { content: [{ type: 'text', text: 'Error: session_id is required' }], isError: true }
        if (
          !action ||
          !['clear', 'quit', 'interrupt', 'set_model', 'set_effort', 'set_permission_mode'].includes(action)
        ) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: action must be one of clear | quit | interrupt | set_model | set_effort | set_permission_mode',
              },
            ],
            isError: true,
          }
        }
        if (action === 'set_model' && !model) {
          return {
            content: [{ type: 'text', text: 'Error: model is required when action is "set_model"' }],
            isError: true,
          }
        }
        if (action === 'set_effort' && !effort) {
          return {
            content: [{ type: 'text', text: 'Error: effort is required when action is "set_effort"' }],
            isError: true,
          }
        }
        if (action === 'set_permission_mode' && !permissionMode) {
          return {
            content: [{ type: 'text', text: 'Error: permissionMode is required when action is "set_permission_mode"' }],
            isError: true,
          }
        }
        const result = await callbacks.onControlSession?.({
          conversationId: targetConversationId,
          action,
          model,
          effort,
          permissionMode,
        })
        if (!result?.ok) {
          debug(`[channel] control_session(${action}) failed: ${result?.error}`)
          return {
            content: [{ type: 'text', text: result?.error || `Failed to control session (${action})` }],
            isError: true,
          }
        }
        debug(
          `[channel] control_session(${action}): ${targetConversationId.slice(0, 8)}${model ? ` model=${model}` : ''}${effort ? ` effort=${effort}` : ''}${permissionMode ? ` mode=${permissionMode}` : ''}`,
        )
        const label = result.name || targetConversationId.slice(0, 8)
        const verbText =
          action === 'clear'
            ? `Clear requested on ${label}. Context will reset in a few seconds.`
            : action === 'quit'
              ? `Quit signal sent to ${label}. The session will end within a few seconds.`
              : action === 'interrupt'
                ? `Interrupt sent to ${label}. Current turn will stop.`
                : action === 'set_model'
                  ? `Model switch requested on ${label} -> ${model}.`
                  : action === 'set_effort'
                    ? `Effort level switch requested on ${label} -> ${effort}.`
                    : `Permission mode switch requested on ${label} -> ${permissionMode}.`
        return { content: [{ type: 'text', text: verbText }] }
      },
    },

    spawn_session: {
      description:
        'Unified session lifecycle tool. Spawn new sessions, revive ended ones, or restart active sessions (terminate + auto-revive). Requires benevolent trust level. Sessions boot in tmux on the host - takes 10-30 seconds. Use list_sessions to poll for status.\n\nWhen spawning: ALWAYS provide a short `description` (1-2 sentences) explaining what the session will do. This is shown in the dashboard and helps the user understand each session at a glance. Also provide a `name` when you have a meaningful label.\n\nActions:\n- spawn (default): Start a new session at a directory\n- revive: Bring back an ended/inactive session\n- restart: Terminate an active session and automatically revive it. For self-restart, the MCP response may not arrive (your process dies and reboots).',
      inputSchema: spawnToolInputSchema,
      async handle(params, ctx) {
        const action = (params.action as 'spawn' | 'revive' | 'restart') || 'spawn'

        // --- REVIVE ---
        if (action === 'revive') {
          const targetConversationId = params.session_id
          if (!targetConversationId)
            return { content: [{ type: 'text', text: 'Error: session_id is required for revive' }], isError: true }
          const result = await callbacks.onReviveConversation?.(targetConversationId)
          if (!result?.ok) {
            debug(`[channel] spawn_session(revive) failed: ${result?.error}`)
            return { content: [{ type: 'text', text: result?.error || 'Failed to revive session' }], isError: true }
          }
          debug(`[channel] spawn_session(revive): ${targetConversationId.slice(0, 8)} (${result.name})`)
          return {
            content: [
              {
                type: 'text',
                text: `Reviving session ${result.name || targetConversationId.slice(0, 8)}. This is async - the session takes 10-30 seconds to start. Use list_sessions to check when status changes to "live".`,
              },
            ],
          }
        }

        // --- RESTART ---
        if (action === 'restart') {
          const targetConversationId = params.session_id
          if (!targetConversationId)
            return { content: [{ type: 'text', text: 'Error: session_id is required for restart' }], isError: true }
          const result = await callbacks.onRestartConversation?.(targetConversationId)
          if (!result?.ok) {
            debug(`[channel] spawn_session(restart) failed: ${result?.error}`)
            return { content: [{ type: 'text', text: result?.error || 'Failed to restart session' }], isError: true }
          }
          debug(
            `[channel] spawn_session(restart): ${targetConversationId.slice(0, 8)} (${result.name}) self=${result.selfRestart}`,
          )
          if (result.selfRestart) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Self-restart initiated for ${result.name || targetConversationId.slice(0, 8)}. This session will terminate and automatically revive. You may not receive this response.`,
                },
              ],
            }
          }
          if (result.alreadyEnded) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Session ${result.name || targetConversationId.slice(0, 8)} was already ended - reviving instead. Use list_sessions to check when ready.`,
                },
              ],
            }
          }
          return {
            content: [
              {
                type: 'text',
                text: `Restarting session ${result.name || targetConversationId.slice(0, 8)}. The session will terminate and automatically revive. Use list_sessions to check when ready (10-30 seconds).`,
              },
            ],
          }
        }

        // --- SPAWN (default) ---
        const cwd = params.cwd
        if (!cwd) return { content: [{ type: 'text', text: 'Error: cwd is required for spawn' }], isError: true }
        const mode = params.mode as 'fresh' | 'resume' | undefined
        const resumeId = params.resume_id
        if (mode === 'resume' && !resumeId) {
          return {
            content: [{ type: 'text', text: 'Error: resume_id is required when mode is "resume"' }],
            isError: true,
          }
        }
        const mkdir = String(params.mkdir) === 'true'
        const spawnHeadless = params.headless !== undefined ? String(params.headless) !== 'false' : true

        // Wire progress streaming if the caller supplied a progressToken.
        // dispatchSpawn always creates a job server-side; we just need a pump
        // to forward launch_progress events as MCP notifications/progress so
        // clients can render a progress bar instead of staring at silence.
        const { progressToken } = ctx
        const extra = ctx.extra as {
          sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>
        }
        let onProgress: ((event: Record<string, unknown>) => void) | undefined
        if (progressToken !== undefined) {
          const stepToPercent: Record<string, number> = {
            job_created: 5,
            spawn_sent: 15,
            agent_acked: 30,
            wrapper_booted: 60,
            session_connected: 95,
            completed: 100,
          }
          onProgress = event => {
            const type = event.type as string
            const step = typeof event.step === 'string' ? event.step : undefined
            const status = typeof event.status === 'string' ? event.status : undefined
            const detail = typeof event.detail === 'string' ? event.detail : undefined
            let progress = 0
            let message = step || type
            if (type === 'job_complete') {
              progress = 100
              message = 'Session connected'
            } else if (type === 'job_failed') {
              progress = 100
              message = `Failed: ${typeof event.error === 'string' ? event.error : 'unknown'}`
            } else if (step && step in stepToPercent) {
              progress = stepToPercent[step]
              if (detail) message = `${step}: ${detail}`
              else message = step
              if (status === 'error') message = `Failed at ${step}`
            }
            extra
              .sendNotification?.({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress,
                  total: 100,
                  message,
                },
              })
              .catch(() => {
                // Notifications are best-effort -- swallow to avoid killing the spawn if the transport hiccups
              })
          }
        }

        const { jobId: _jobId, cwd: _cwd, host: _host, ...spawnRest } = params as SpawnRequest & Record<string, unknown>
        const sentinel = (params.host as string) || (params.sentinel as string) || undefined
        const result = (await callbacks.onSpawnConversation?.({
          ...spawnRest,
          cwd,
          sentinel,
          mode,
          resumeId,
          mkdir,
          headless: spawnHeadless,
          onProgress,
        })) as
          | {
              ok: boolean
              error?: string
              conversationId?: string
              jobId?: string
              session?: Record<string, unknown>
              timedOut?: boolean
            }
          | undefined
        if (!result?.ok) {
          debug(`[channel] spawn_session failed: ${result?.error}`)
          return { content: [{ type: 'text', text: result?.error || 'Failed to spawn session' }], isError: true }
        }
        const modeDesc = mode === 'resume' ? `resuming ${resumeId}` : 'fresh start'
        debug(`[channel] spawn_session: ${cwd} (${modeDesc}) session=${result.session ? 'ready' : 'pending'}`)

        if (result.session) {
          const sessionObj = result.session as Record<string, unknown>
          const mismatch = sessionObj.modelMismatch as
            | { requested: string; actual: string; detectedAt: number }
            | undefined
          const responsePayload: Record<string, unknown> = {
            status: 'ready',
            message: `Session spawned and connected at ${cwd} (${modeDesc})`,
            session_id: sessionObj.id,
            session: result.session,
            jobId: result.jobId,
            conversationId: result.conversationId,
          }
          if (mismatch) {
            responsePayload.modelWarning = `Requested model ${mismatch.requested} but session is running ${mismatch.actual}`
            responsePayload.modelMismatch = mismatch
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(responsePayload, null, 2) }],
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: result.timedOut
                ? `Session spawn sent to ${cwd} (${modeDesc}) but session did not connect within the rendezvous timeout. It may still be booting - use list_sessions to check.${result.jobId ? ` jobId=${result.jobId}` : ''}`
                : `Session spawning at ${cwd} (${modeDesc}). Use list_sessions to check when ready.${result.jobId ? ` jobId=${result.jobId}` : ''}`,
            },
          ],
        }
      },
    },

    list_hosts: {
      description:
        'List connected sentinel hosts. Each sentinel is a machine that can spawn sessions. Use the alias as the `host` parameter in spawn_session to target a specific machine.',
      inputSchema: { type: 'object' as const, properties: {} },
      async handle() {
        const result = (await callbacks.onListHosts?.()) || []
        debug(`[channel] list_hosts: ${result.length} hosts`)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    },

    get_spawn_diagnostics: {
      description:
        'Fetch a diagnostic snapshot for a spawn job by jobId. Returns the resolved config, the full event timeline (job_created, spawn_sent, agent_acked, wrapper_booted, session_connected, job_complete/job_failed), and any error. Use this to debug spawn failures after spawn_session returned a conversationId but the session never connected. Jobs expire ~5 minutes after creation. The jobId is returned in every spawn_session response.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          job_id: {
            type: 'string',
            description: 'The jobId returned by a prior spawn_session call (or any spawn dispatch).',
          },
        },
        required: ['job_id'],
      },
      async handle(params) {
        const jobId = typeof params.job_id === 'string' ? params.job_id.trim() : ''
        if (!jobId) {
          return {
            content: [{ type: 'text', text: 'Error: job_id is required' }],
            isError: true,
          }
        }
        if (!callbacks.onGetSpawnDiagnostics) {
          return {
            content: [{ type: 'text', text: 'Error: diagnostics channel not available' }],
            isError: true,
          }
        }
        const result = await callbacks.onGetSpawnDiagnostics(jobId)
        if (!result.ok) {
          debug(`[channel] get_spawn_diagnostics(${jobId.slice(0, 8)}) failed: ${result.error}`)
          return {
            content: [{ type: 'text', text: result.error || 'Diagnostics unavailable' }],
            isError: true,
          }
        }
        debug(`[channel] get_spawn_diagnostics(${jobId.slice(0, 8)}): ok`)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result.diagnostics, null, 2),
            },
          ],
        }
      },
    },

    exit_session: {
      description:
        'Terminate the current session. Emits a lifecycle event, sends session end to the broker, and exits the process. Use when your work is done and you want to clean up. The MCP response may not arrive back (the process exits immediately after).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['success', 'error'],
            description: 'Exit status (default: success)',
          },
          message: {
            type: 'string',
            description: 'Reason for exiting (shown in transcript timeline)',
          },
        },
      },
      async handle(params) {
        const status = (params.status as 'success' | 'error') || 'success'
        const message = typeof params.message === 'string' ? params.message : undefined
        debug(`[channel] exit_session: status=${status} message=${message || '(none)'}`)
        callbacks.onExitConversation?.(status, message)
        return { content: [{ type: 'text', text: `Session exiting (${status})` }] }
      },
    },

    configure_session: {
      description:
        "Update another session's project settings: label, icon, color, description, keyterms. Requires benevolent trust level. Cannot change trust/permission levels.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Target ID from list_sessions' },
          label: { type: 'string', description: 'Display name for the project' },
          icon: { type: 'string', description: 'Lucide icon ID (e.g. "rocket", "database", "globe")' },
          color: { type: 'string', description: 'Hex color (e.g. "#ff6600")' },
          description: { type: 'string', description: 'Project description for routing context' },
          keyterms: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keywords for project search/categorization',
          },
        },
        required: ['session_id'],
      },
      async handle(params) {
        const targetConversationId = params.session_id
        if (!targetConversationId)
          return { content: [{ type: 'text', text: 'Error: session_id is required' }], isError: true }
        const update: Record<string, unknown> = {}
        if (params.label !== undefined) update.label = params.label
        if (params.icon !== undefined) update.icon = params.icon
        if (params.color !== undefined) update.color = params.color
        if (params.description !== undefined) update.description = params.description
        if (params.keyterms !== undefined) update.keyterms = params.keyterms
        if (Object.keys(update).length === 0) {
          return { content: [{ type: 'text', text: 'Error: at least one setting is required' }], isError: true }
        }
        const result = await callbacks.onConfigureConversation?.({
          conversationId: targetConversationId,
          ...update,
        } as Parameters<NonNullable<McpChannelCallbacks['onConfigureConversation']>>[0])
        if (!result?.ok) {
          debug(`[channel] configure_session failed: ${result?.error}`)
          return {
            content: [{ type: 'text', text: result?.error || 'Failed to configure session' }],
            isError: true,
          }
        }
        debug(`[channel] configure_session: ${targetConversationId.slice(0, 8)} ${Object.keys(update).join(',')}`)
        return { content: [{ type: 'text', text: `Session configured: ${Object.keys(update).join(', ')} updated` }] }
      },
    },

    rename_session: {
      description:
        'Rename the current session and/or set its description. The title is visible in the dashboard sidebar. Use slug-formatted names for consistency (e.g. "refactor-auth-middleware"). Pass empty name to clear and revert to auto-generated name. Description is a short line shown in sidebar and list_sessions -- use it to explain what this session is working on.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: {
            type: 'string',
            description: 'New session name/title. Empty string clears user-set name.',
          },
          description: {
            type: 'string',
            description:
              'Short description of what this session is working on. Shown in dashboard and list_sessions. Empty string clears.',
          },
        },
        required: ['name'],
      },
      async handle(params) {
        const newName = typeof params.name === 'string' ? params.name : ''
        const newDesc = typeof params.description === 'string' ? params.description : undefined
        const result = await callbacks.onRenameConversation?.(newName, newDesc)
        if (!result?.ok) {
          debug(`[channel] rename_session failed: ${result?.error}`)
          return {
            content: [{ type: 'text', text: result?.error || 'Failed to rename session' }],
            isError: true,
          }
        }
        const label = newName || '(auto)'
        debug(`[channel] rename_session: "${label}"${newDesc ? ` desc="${newDesc}"` : ''}`)
        return { content: [{ type: 'text', text: `Session renamed to "${label}"` }] }
      },
    },

    check_update: {
      description:
        'Check if a newer version of rclaude is available. Queries the GitHub API to compare the installed build against the latest commit on the branch it was built from. No arguments needed.',
      inputSchema: { type: 'object' as const, properties: {} },
      async handle() {
        const result = await checkForUpdate()
        debug(`[channel] check_update: ${result.upToDate ? 'up to date' : `${result.behindBy} behind`}`)
        return { content: [{ type: 'text', text: formatUpdateResult(result, claudeCodeVersion) }] }
      },
    },

    project_list: {
      description:
        'List tasks from the project board (.rclaude/project/). Returns tasks grouped by status with their frontmatter (title, priority, tags, refs) and relative file paths. By default shows open + in-progress only. To edit tasks, read/write the markdown files directly. To change status, mv the file between status folders.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: [...TASK_STATUSES, 'all'],
            description: `Filter by status folder. Default: all (${DEFAULT_VISIBLE_STATUSES.join(' + ')})`,
          },
          show_done: {
            type: 'boolean',
            description: 'Include done tasks when status is "all" (default: false)',
          },
          show_archived: {
            type: 'boolean',
            description: 'Include archived tasks when status is "all" (default: false)',
          },
          filter: {
            type: 'string',
            description:
              'Filter tasks by glob pattern (matched against title, filename, and tags). Case-insensitive. Examples: "bug*", "*refactor*", "*sqlite*". Wrap in /slashes/ for regex.',
          },
        },
      },
      async handle(params) {
        const statusFilter = params.status || 'all'
        let statuses: string[]
        if (statusFilter === 'all') {
          statuses = [...DEFAULT_VISIBLE_STATUSES]
          if (String(params.show_done) === 'true') statuses.push('done')
          if (String(params.show_archived) === 'true') statuses.push('archived')
        } else {
          statuses = [statusFilter]
        }

        // Build filter matcher: /regex/ or glob pattern (* wildcards)
        let filterRe: RegExp | null = null
        if (params.filter) {
          const f = params.filter
          const regexMatch = f.match(/^\/(.+)\/([gimsuy]*)$/)
          if (regexMatch) {
            filterRe = new RegExp(regexMatch[1], regexMatch[2] || 'i')
          } else {
            // Convert glob to regex: * -> .*, escape the rest
            const escaped = f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
            filterRe = new RegExp(escaped, 'i')
          }
        }

        const projectDir = join(dialogCwd, '.rclaude', 'project')
        const results: string[] = []
        for (const status of statuses) {
          const dir = join(projectDir, status)
          try {
            const files = readdirSync(dir)
              .filter(f => f.endsWith('.md'))
              .map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime)
            for (const { name: file } of files) {
              try {
                const content = readFileSync(join(dir, file), 'utf-8')
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
                const fm = fmMatch ? fmMatch[1] : ''

                // Apply filter against title, filename, and tags
                if (filterRe) {
                  const titleMatch = fm.match(/title:\s*["']?(.+?)["']?\s*$/m)
                  const title = titleMatch ? titleMatch[1] : ''
                  const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/m)
                  const tags = tagsMatch ? tagsMatch[1] : ''
                  const searchable = `${file} ${title} ${tags}`
                  if (!filterRe.test(searchable)) continue
                }

                const relPath = `.rclaude/project/${status}/${file}`
                results.push(`## ${relPath}\n${fm}`)
              } catch {
                /* skip unreadable */
              }
            }
          } catch {
            /* dir doesn't exist yet */
          }
        }
        const output =
          results.length > 0
            ? results.join('\n\n')
            : params.filter
              ? `No tasks matching "${params.filter}". Try a broader pattern.`
              : 'No tasks found. Create one with: Write .rclaude/project/open/my-task.md'
        debug(
          `[channel] project_list: ${results.length} tasks (filter=${statusFilter}${params.filter ? `, pattern=${params.filter}` : ''})`,
        )
        return { content: [{ type: 'text', text: output }] }
      },
    },

    project_set_status: {
      description:
        'Move a project task to a different status column on the board. Use the filename (without .md) as the task ID. Avoids needing Bash mv which triggers permission prompts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description: 'Task filename without .md extension (e.g. "my-task" or "bug-conduit-session")',
          },
          status: {
            type: 'string',
            enum: [...TASK_STATUSES],
            description: 'Target status folder',
          },
        },
        required: ['id', 'status'],
      },
      async handle(params) {
        const taskId = params.id
        const targetStatus = params.status as TaskStatus
        if (!taskId) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true }
        if (!(TASK_STATUSES as readonly string[]).includes(targetStatus))
          return { content: [{ type: 'text', text: `Error: invalid status "${targetStatus}"` }], isError: true }

        // Find the task in any status folder
        const allStatuses = TASK_STATUSES
        let fromStatus: TaskStatus | null = null
        for (const s of allStatuses) {
          const dir = join(dialogCwd, '.rclaude', 'project', s)
          try {
            if (readdirSync(dir).includes(`${taskId}.md`)) {
              fromStatus = s
              break
            }
          } catch {}
        }
        if (!fromStatus) return { content: [{ type: 'text', text: `Task "${taskId}" not found` }], isError: true }
        if (fromStatus === targetStatus)
          return { content: [{ type: 'text', text: `"${taskId}" is already ${formatStatus(targetStatus)}` }] }

        // Read title from frontmatter before moving
        let taskTitle = taskId
        try {
          const raw = readFileSync(join(dialogCwd, '.rclaude', 'project', fromStatus, `${taskId}.md`), 'utf-8')
          const titleMatch = raw.match(/^title:\s*(.+)$/m)
          if (titleMatch?.[1]) taskTitle = titleMatch[1].trim()
        } catch {}

        const newSlug = moveProjectTask(dialogCwd, taskId, fromStatus, targetStatus)
        if (!newSlug) return { content: [{ type: 'text', text: 'Failed to move task' }], isError: true }
        callbacks.onProjectChanged?.()
        debug(`[channel] set_task_status: ${taskId} ${fromStatus} -> ${targetStatus} (slug: ${newSlug})`)
        const newPath = `.rclaude/project/${targetStatus}/${newSlug}.md`
        const renamed = newSlug !== taskId ? ` (renamed to "${newSlug}")` : ''
        return {
          content: [
            {
              type: 'text',
              text: `Moved "${taskTitle}" from ${formatStatus(fromStatus)} to ${formatStatus(targetStatus)}${renamed}\nThe task file is now located at ${newPath}`,
            },
          ],
        }
      },
    },

    dialog: {
      description:
        'PREFERRED way to interact with users. Use this PROACTIVELY whenever you need user input, decisions, confirmations, or want to present structured information. Do NOT ask questions in plain text -- use dialog instead for a rich UI experience. Shows an interactive dialog modal in the dashboard and waits for the user to respond. Supports: choices (single/multi select), text inputs, toggles, sliders, image display and selection, markdown content, code blocks, mermaid diagrams, alerts, collapsible groups, grids, and multi-page wizards. The user interacts on their device (phone/desktop) and the result comes back as structured JSON. BLOCKING call -- waits for submit/cancel/timeout (default 5 min, auto-extends on user interaction). Use "body" for single-page or "pages" for multi-step flows.',
      inputSchema: dialogToolInputSchema(),
      async handle(_params, ctx) {
        try {
          elog(' ENTER')
          const layout = ctx.rawArgs as unknown as DialogLayout
          elog(` validating layout title="${layout?.title}"`)
          const validationErrors = validateDialogLayout(layout)
          if (validationErrors.length > 0) {
            elog(` validation failed: ${validationErrors.join('; ')}`)
            return {
              content: [{ type: 'text', text: `Invalid dialog layout:\n${validationErrors.join('\n')}` }],
              isError: true,
            }
          }

          // Resolve local file paths in Image/ImagePicker components
          elog(' resolving file paths...')
          const allComponents: Array<Record<string, unknown>> = []
          if (layout.body) allComponents.push(...(layout.body as unknown as Array<Record<string, unknown>>))
          if (layout.pages) {
            for (const page of layout.pages as unknown as Array<{ body: Array<Record<string, unknown>> }>) {
              allComponents.push(...page.body)
            }
          }
          elog(` ${allComponents.length} top-level components`)
          const uploader = callbacks.onShareFile
          if (uploader) {
            debug('[channel] dialog: uploading files (CWD-jailed)')
            const uploadErr = await resolveDialogFiles(allComponents, uploader, dialogCwd)
            if (uploadErr) {
              elog(` upload error: ${uploadErr}`)
              return { content: [{ type: 'text', text: `Dialog file error: ${uploadErr}` }], isError: true }
            }
            elog(' file upload complete')
          }

          // Apply defaults
          const timeout = (layout.timeout ?? 300) * 1000
          const dialogId = randomUUID()

          elog(` "${layout.title}" (${dialogId.slice(0, 8)}, timeout=${timeout / 1000}s)`)

          // Forward to broker via callback
          callbacks.onDialogShow?.(dialogId, layout)
          elog(` forwarded to broker, waiting for result...`)

          // Non-blocking: return immediately, deliver result via channel notification.
          // CC has an internal ~60s timeout on MCP tool calls that we can't override.
          // The result will arrive as a <channel> message when the user submits.
          const timer = setTimeout(() => {
            const pending = pendingDialogs.get(dialogId)
            if (pending) {
              pendingDialogs.delete(dialogId)
              elog(` timeout: ${dialogId.slice(0, 8)}`)
              callbacks.onDeliverMessage?.('Dialog timed out - user did not respond.', {
                sender: 'dialog',
                dialog_id: dialogId,
                status: 'timeout',
              })
              callbacks.onDialogDismiss?.(dialogId)
            }
          }, timeout)

          pendingDialogs.set(dialogId, {
            resolve: () => {}, // resolved via channel notification, not tool return
            timer,
            timeoutMs: timeout,
            deadline: Date.now() + timeout,
          })

          elog(` returned immediately (result via channel)`)
          return {
            content: [
              {
                type: 'text',
                text: `Dialog "${layout.title}" shown to user. The response will arrive as a channel message when the user submits. Dialog ID: ${dialogId}`,
              },
            ],
          }
        } catch (exploreErr) {
          const msg = exploreErr instanceof Error ? exploreErr.stack || exploreErr.message : String(exploreErr)
          elog(` CRASH: ${msg}`)
          // Write crash to file for post-mortem
          try {
            const crashFile = `/tmp/rclaude-dialog-crash-${Date.now()}.log`
            await Bun.write(crashFile, `${new Date().toISOString()}\n${msg}\n`)
            elog(` crash log: ${crashFile}`)
          } catch {
            /* ignore write failure */
          }
          return { content: [{ type: 'text', text: `Dialog internal error: ${msg}` }], isError: true }
        }
      },
    },

    // Legacy alias -- hidden from ListTools, still handled by CallTool for backwards compat
    revive_session: {
      description: 'Legacy alias for spawn_session with action=revive. Prefer spawn_session.',
      hidden: true,
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Target session ID from list_sessions' },
        },
        required: ['session_id'],
      },
      async handle(params) {
        const targetConversationId = params.session_id
        if (!targetConversationId)
          return { content: [{ type: 'text', text: 'Error: session_id is required' }], isError: true }
        const result = await callbacks.onReviveConversation?.(targetConversationId)
        if (!result?.ok) {
          return { content: [{ type: 'text', text: result?.error || 'Failed to revive session' }], isError: true }
        }
        return {
          content: [
            {
              type: 'text',
              text: `Reviving session ${result.name || targetConversationId.slice(0, 8)}. Use list_sessions to check when ready.`,
            },
          ],
        }
      },
    },
  }

  // Register MCP tools -- schema list derived from registry (hidden tools excluded)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools)
      .filter(([, def]) => !def.hidden)
      .map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: def.inputSchema,
      })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const { name, arguments: args } = request.params
      const params = (args || {}) as Record<string, string>
      // MCP clients opt into streaming progress by supplying a progressToken
      // in the request _meta. If present, we push notifications/progress
      // during long-running tools (currently spawn_session).
      const progressToken = (request.params._meta as { progressToken?: string | number } | undefined)?.progressToken

      const def = tools[name]
      if (!def) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
      return await def.handle(params, { progressToken, rawArgs: args, extra })
    } catch (err) {
      debug(`[channel] CallTool error: ${err instanceof Error ? err.message : err}`)
      return {
        content: [{ type: 'text', text: `Internal error: ${err instanceof Error ? err.message : 'unknown'}` }],
        isError: true,
      }
    }
  })

  // Listen for notifications FROM Claude Code (permission requests, future event types).
  // CC sends permission_request when it needs tool approval and we declared claude/channel/permission.
  server.fallbackNotificationHandler = async notification => {
    try {
      if (notification.method === 'notifications/claude/channel/permission_request') {
        const params = (notification.params || {}) as Record<string, unknown>
        const requestId = typeof params.request_id === 'string' ? params.request_id : ''
        const toolName = typeof params.tool_name === 'string' ? params.tool_name : ''
        const description = typeof params.description === 'string' ? params.description : ''
        const inputPreview = typeof params.input_preview === 'string' ? params.input_preview : ''

        debug(`[channel] Permission request: ${requestId} ${toolName} - ${description.slice(0, 80)}`)
        callbacks.onPermissionRequest?.({ requestId, toolName, description, inputPreview })
      } else {
        debug(`[channel] Unhandled notification: ${notification.method}`)
      }
    } catch (err) {
      debug(`[channel] Notification handler error: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Create stateful transport -- single session, single client (Claude Code)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  })

  // Detect transport close (disconnect)
  transport.onclose = () => {
    debug('[channel] Transport closed (client disconnected)')
    if (state) state.connected = false
    callbacks.onDisconnect?.()
  }

  transport.onerror = err => {
    debug(`[channel] Transport error: ${err.message}`)
  }

  state = { mcpServer, transport, connected: false }

  // Keepalive: send periodic no-op notifications to prevent idle timeout.
  // The MCP SDK sends these through the SSE stream as events, keeping it alive.
  keepaliveTimer = setInterval(() => {
    if (!state?.connected) return
    try {
      // Send an empty log notification as keepalive -- lightweight, doesn't pollute Claude's context
      state.mcpServer.server.notification({
        method: 'notifications/message',
        params: { level: 'debug', data: 'keepalive', logger: 'rclaude' },
      })
    } catch {
      // Transport might be dead
      debug('[channel] Keepalive failed, marking disconnected')
      if (state) state.connected = false
      callbacks.onDisconnect?.()
    }
  }, 120_000) // every 2 minutes (well under 255s Bun timeout)

  debug('[channel] MCP channel server initialized')
}

/**
 * Connect the MCP server to the transport.
 * Must be called once before handling requests.
 */
export async function connectMcpChannel(): Promise<void> {
  if (!state || state.connected) return
  try {
    await state.mcpServer.connect(state.transport)
    state.connected = true
    debug('[channel] MCP server connected to transport')
  } catch (err) {
    debug(`[channel] MCP server connect failed: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Handle an incoming HTTP request on the /mcp endpoint.
 * All requests go to the single transport instance.
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  if (!state) return new Response('MCP channel not initialized', { status: 503 })
  try {
    if (!state.connected) await connectMcpChannel()
    return await state.transport.handleRequest(req)
  } catch (err) {
    debug(`[channel] handleMcpRequest error: ${err instanceof Error ? err.message : err}`)
    return new Response('MCP request failed', { status: 500 })
  }
}

/**
 * Push a channel notification to Claude Code.
 * This is the primary input path -- dashboard messages go through here.
 */
export async function pushChannelMessage(message: string, meta?: Record<string, string>): Promise<boolean> {
  if (!state?.connected) {
    debug('[channel] Cannot push: not connected')
    return false
  }

  try {
    // Send notification through the active transport
    const notification = {
      method: 'notifications/claude/channel' as const,
      params: {
        content: message,
        meta: {
          sender: 'dashboard',
          ts: new Date().toISOString(),
          ...meta,
        },
      },
    }
    await state.mcpServer.server.notification(notification)
    debug(`[channel] Pushed: ${message.slice(0, 80)}`)
    return true
  } catch (err) {
    debug(`[channel] Push failed: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

/**
 * Check if there are pending dialogs waiting for user response.
 */
export function hasPendingDialogs(): boolean {
  return pendingDialogs.size > 0
}

/**
 * Check if the MCP channel is initialized and connected.
 */
export function isMcpChannelReady(): boolean {
  return state?.connected ?? false
}

/**
 * Set the Claude Code CLI version for use in update check responses.
 */
export function setClaudeCodeVersion(version: string | undefined): void {
  claudeCodeVersion = version
}

/**
 * Send a permission response back to Claude Code.
 * Called when the dashboard user clicks ALLOW or DENY.
 */
export async function sendPermissionResponse(requestId: string, behavior: 'allow' | 'deny'): Promise<boolean> {
  if (!state?.connected) {
    debug('[channel] Cannot send permission response: not connected')
    return false
  }

  try {
    await state.mcpServer.server.notification({
      method: 'notifications/claude/channel/permission' as const,
      params: { request_id: requestId, behavior },
    })
    debug(`[channel] Permission response: ${requestId} -> ${behavior}`)
    return true
  } catch (err) {
    debug(`[channel] Permission response failed: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

/**
 * Reset the MCP channel for a fresh CC process (e.g. after /clear).
 * Closes the old transport, clears pending state, creates a fresh transport,
 * and re-connects the McpServer. The HTTP server and port are unchanged --
 * only the internal transport is recycled so the new CC gets a clean connection.
 */
export async function resetMcpChannel(): Promise<void> {
  if (!state) return

  // Close old transport (releases any lingering SSE connections from dead CC)
  try {
    await state.transport.close()
  } catch {}

  // Clear pending dialogs (stale from old CC)
  for (const [, pending] of pendingDialogs) {
    clearTimeout(pending.timer)
    pending.resolve({ _action: 'dismiss', _timeout: false, _cancelled: true })
  }
  pendingDialogs.clear()

  // Create fresh transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  })
  transport.onclose = () => {
    debug('[channel] Transport closed (client disconnected)')
    if (state) state.connected = false
    callbacks.onDisconnect?.()
  }
  transport.onerror = err => {
    debug(`[channel] Transport error: ${err.message}`)
  }

  // Re-connect McpServer to fresh transport
  state.transport = transport
  state.connected = false
  try {
    await state.mcpServer.connect(transport)
    state.connected = true
    debug('[channel] MCP channel reset -- fresh transport connected')
  } catch (err) {
    debug(`[channel] MCP channel reset failed: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Shut down the MCP channel server.
 */
export async function closeMcpChannel(): Promise<void> {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
  if (state) {
    try {
      await state.transport.close()
    } catch {}
    try {
      await state.mcpServer.close()
    } catch {}
    state = null
    debug('[channel] MCP channel server closed')
  }
}
