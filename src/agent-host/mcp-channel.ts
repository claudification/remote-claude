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
 *
 * Tool handlers are in src/agent-host/mcp-tools/ -- each file registers a group
 * of related tools. This file owns the MCP server lifecycle and transport plumbing.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { DialogResult } from '../shared/dialog-schema'
import { debug } from './debug'
import {
  type AgentHostIdentity,
  type McpChannelCallbacks,
  type McpToolContext,
  type PendingDialog,
  registerAllTools,
} from './mcp-tools'

// Re-export types for consumers that import from mcp-channel
export type { AgentHostIdentity, ConversationInfo, McpChannelCallbacks, PermissionRequestData } from './mcp-tools'

const DIALOG_LOG = '/tmp/rclaude-dialog.log'

function elog(msg: string): void {
  try {
    appendFileSync(DIALOG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* ignore */
  }
  debug(`[dialog] ${msg}`)
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
const pendingDialogs = new Map<string, PendingDialog>()

let dialogCwd = process.cwd()

export function setDialogCwd(cwd: string): void {
  dialogCwd = cwd
}

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

export function keepaliveDialog(dialogId: string): boolean {
  const pending = pendingDialogs.get(dialogId)
  if (!pending) return false

  const minRemaining = pending.timeoutMs * 0.5
  const remaining = pending.deadline - Date.now()

  if (remaining < minRemaining) {
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
  const server = mcpServer.server

  const toolCtx: McpToolContext = {
    callbacks,
    getIdentity: () => identity,
    getClaudeCodeVersion: () => claudeCodeVersion,
    getDialogCwd: () => dialogCwd,
    pendingDialogs,
    elog,
  }
  const tools = registerAllTools(toolCtx)

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

  state = { mcpServer, transport, connected: false }

  keepaliveTimer = setInterval(() => {
    if (!state?.connected) return
    try {
      state.mcpServer.server.notification({
        method: 'notifications/message',
        params: { level: 'debug', data: 'keepalive', logger: 'rclaude' },
      })
    } catch {
      debug('[channel] Keepalive failed, marking disconnected')
      if (state) state.connected = false
      callbacks.onDisconnect?.()
    }
  }, 120_000)

  debug('[channel] MCP channel server initialized')
}

async function connectMcpChannel(): Promise<void> {
  if (!state || state.connected) return
  try {
    await state.mcpServer.connect(state.transport)
    state.connected = true
    debug('[channel] MCP server connected to transport')
  } catch (err) {
    debug(`[channel] MCP server connect failed: ${err instanceof Error ? err.message : err}`)
  }
}

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

export async function pushChannelMessage(message: string, meta?: Record<string, string>): Promise<boolean> {
  if (!state?.connected) {
    debug('[channel] Cannot push: not connected')
    return false
  }

  try {
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

export function hasPendingDialogs(): boolean {
  return pendingDialogs.size > 0
}

export function isMcpChannelReady(): boolean {
  return state?.connected ?? false
}

export function setClaudeCodeVersion(version: string | undefined): void {
  claudeCodeVersion = version
}

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

export async function resetMcpChannel(): Promise<void> {
  if (!state) return

  try {
    await state.transport.close()
  } catch {}

  for (const [, pending] of pendingDialogs) {
    clearTimeout(pending.timer)
    pending.resolve({ _action: 'dismiss', _timeout: false, _cancelled: true })
  }
  pendingDialogs.clear()

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
