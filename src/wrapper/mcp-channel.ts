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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { debug } from './debug'

export interface McpChannelCallbacks {
  onReply?: (message: string, meta?: Record<string, string>) => void
  onNotify?: (message: string, title?: string) => void
  onDisconnect?: () => void
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
        experimental: { 'claude/channel': {} },
      },
    },
  )

  // Register tools for two-way communication
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Send a message back to the rclaude dashboard. Use this to communicate structured responses, status updates, or completion notifications to the remote user.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            message: { type: 'string', description: 'The message to send to the dashboard' },
          },
          required: ['message'],
        },
      },
      {
        name: 'notify',
        description: 'Send a push notification to the user\'s devices (phone, browser). Use for important alerts that need attention even when the dashboard is not in focus.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            message: { type: 'string', description: 'Notification body text' },
            title: { type: 'string', description: 'Optional notification title' },
          },
          required: ['message'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const params = (args || {}) as Record<string, string>

    switch (name) {
      case 'reply': {
        const message = params.message
        if (!message) return { content: [{ type: 'text', text: 'Error: message is required' }], isError: true }
        callbacks.onReply?.(message)
        debug(`[channel] reply: ${message.slice(0, 80)}`)
        return { content: [{ type: 'text', text: 'Sent to dashboard' }] }
      }
      case 'notify': {
        const message = params.message
        const title = params.title
        if (!message) return { content: [{ type: 'text', text: 'Error: message is required' }], isError: true }
        callbacks.onNotify?.(message, title)
        debug(`[channel] notify: ${message.slice(0, 80)}`)
        return { content: [{ type: 'text', text: 'Notification sent' }] }
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  })

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

  transport.onerror = (err) => {
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
  await state.server.connect(state.transport)
  state.connected = true
  debug('[channel] MCP server connected to transport')
}

/**
 * Handle an incoming HTTP request on the /mcp endpoint.
 * All requests go to the single transport instance.
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  if (!state) return new Response('MCP channel not initialized', { status: 503 })
  if (!state.connected) await connectMcpChannel()
  return state.transport.handleRequest(req)
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
 * Shut down the MCP channel server.
 */
export async function closeMcpChannel(): Promise<void> {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
  if (state) {
    try { await state.transport.close() } catch {}
    try { await state.server.close() } catch {}
    state = null
    debug('[channel] MCP channel server closed')
  }
}
