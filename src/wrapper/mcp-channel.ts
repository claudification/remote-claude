/**
 * MCP Channel Server for rclaude
 *
 * Implements a Claude Code Channel via MCP Streamable HTTP transport.
 * Claude Code connects to this server and receives dashboard input
 * as channel notifications instead of PTY keystroke injection.
 *
 * Architecture:
 *   Dashboard -> concentrator WS -> rclaude -> mcp.notification()
 *   -> SSE stream -> Claude Code sees <channel source="rclaude">message</channel>
 *
 * Two-way: Claude calls mcp tools (reply, notify) -> rclaude -> concentrator -> dashboard
 */

import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { debug } from './debug'

export interface SessionInfo {
  id: string
  name: string
  cwd: string
  status: 'live' | 'inactive'
  title?: string
  summary?: string
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
  onListSessions?: (status?: string) => Promise<SessionInfo[]>
  onSendMessage?: (
    to: string,
    intent: string,
    message: string,
    context?: string,
    conversationId?: string,
  ) => Promise<{ ok: boolean; error?: string; conversationId?: string }>
  onPermissionRequest?: (data: PermissionRequestData) => void
  onDisconnect?: () => void
  onTogglePlanMode?: () => void
}

interface McpChannelState {
  server: Server
  transport: WebStandardStreamableHTTPServerTransport
  connected: boolean
}

let state: McpChannelState | null = null
let callbacks: McpChannelCallbacks = {}
let keepaliveTimer: ReturnType<typeof setInterval> | null = null

/**
 * Initialize the MCP channel server.
 * Call once on startup. The transport handles HTTP requests via handleMcpRequest().
 */
export function initMcpChannel(cb: McpChannelCallbacks): void {
  callbacks = cb

  const server = new Server(
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

  // Register MCP tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'notify',
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
      },
      {
        name: 'share_file',
        description:
          'Upload a local file to the rclaude concentrator and get a public URL back. For images use ![description](url), for other files use [filename](url). Works for images, screenshots, build artifacts, logs, or any file.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the local file to share' },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'list_sessions',
        description:
          'List other active Claude Code sessions that support channel communication. Returns session ID, project name, status, and optional title/summary.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            status: {
              type: 'string',
              enum: ['live', 'inactive', 'all'],
              description: 'Filter by status (default: live)',
            },
          },
        },
      },
      {
        name: 'send_message',
        description:
          'Send a message to another Claude Code session. Requires an established link (first contact triggers approval prompt on the receiving session). Include conversation_id in replies to maintain thread context.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            to: { type: 'string', description: 'Target session ID (from list_sessions)' },
            intent: {
              type: 'string',
              enum: ['request', 'response', 'notify', 'progress'],
              description: 'Message intent',
            },
            message: { type: 'string', description: 'Message content' },
            context: { type: 'string', description: 'Brief context about what this relates to' },
            conversation_id: { type: 'string', description: 'Thread ID for multi-turn exchanges' },
          },
          required: ['to', 'intent', 'message'],
        },
      },
      {
        name: 'toggle_plan_mode',
        description:
          'Toggle plan mode via the terminal session. Use as a fallback when ExitPlanMode is not available. The toggle takes effect after your current response completes.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const { name, arguments: args } = request.params
      const params = (args || {}) as Record<string, string>

      switch (name) {
        case 'notify': {
          const message = params.message
          const title = params.title
          if (!message) return { content: [{ type: 'text', text: 'Error: message is required' }], isError: true }
          callbacks.onNotify?.(message, title)
          debug(`[channel] notify: ${message.slice(0, 80)}`)
          return { content: [{ type: 'text', text: 'Notification sent' }] }
        }
        case 'share_file': {
          const filePath = params.file_path
          if (!filePath) return { content: [{ type: 'text', text: 'Error: file_path is required' }], isError: true }
          const url = await callbacks.onShareFile?.(filePath)
          if (!url) return { content: [{ type: 'text', text: `Failed to upload ${filePath}` }], isError: true }
          debug(`[channel] share_file: ${filePath} -> ${url}`)
          return { content: [{ type: 'text', text: url }] }
        }
        case 'list_sessions': {
          const sessions = (await callbacks.onListSessions?.(params.status)) || []
          debug(`[channel] list_sessions: ${sessions.length} results`)
          return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }] }
        }
        case 'send_message': {
          const { to, intent, message, context, conversation_id } = params
          if (!to || !intent || !message) {
            return { content: [{ type: 'text', text: 'Error: to, intent, and message are required' }], isError: true }
          }
          const result = await callbacks.onSendMessage?.(to, intent, message, context, conversation_id)
          if (!result?.ok) {
            debug(`[channel] send_message failed: ${result?.error}`)
            return { content: [{ type: 'text', text: result?.error || 'Failed to send message' }], isError: true }
          }
          debug(`[channel] send_message to ${to}: ${message.slice(0, 60)}`)
          const response = result.conversationId ? `Sent. conversation_id: ${result.conversationId}` : 'Sent.'
          return { content: [{ type: 'text', text: response }] }
        }
        case 'toggle_plan_mode': {
          callbacks.onTogglePlanMode?.()
          return { content: [{ type: 'text', text: 'Plan mode toggle sent via PTY.' }] }
        }
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
      }
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

  state = { server, transport, connected: false }

  // Keepalive: send periodic no-op notifications to prevent idle timeout.
  // The MCP SDK sends these through the SSE stream as events, keeping it alive.
  keepaliveTimer = setInterval(() => {
    if (!state?.connected) return
    try {
      // Send an empty log notification as keepalive -- lightweight, doesn't pollute Claude's context
      state.server.notification({
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
    await state.server.connect(state.transport)
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
    await state.server.notification(notification)
    debug(`[channel] Pushed: ${message.slice(0, 80)}`)
    return true
  } catch (err) {
    debug(`[channel] Push failed: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

/**
 * Check if the MCP channel is initialized and connected.
 */
export function isMcpChannelReady(): boolean {
  return state?.connected ?? false
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
    await state.server.notification({
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
      await state.server.close()
    } catch {}
    state = null
    debug('[channel] MCP channel server closed')
  }
}
