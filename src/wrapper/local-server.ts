/**
 * Local HTTP Server
 * Receives hook callbacks from claude via curl POST
 * Optionally serves MCP Streamable HTTP endpoint for channel input
 */

import type { Server } from 'bun'
import type { AskQuestionItem, AskQuestionRequest, HookEvent, HookEventData, HookEventType } from '../shared/protocol'
import { handleMcpRequest } from './mcp-channel'

type HttpServer = Server<unknown>

/** Hook response JSON for AskUserQuestion -- returned to CC via PreToolUse hook stdout */
interface AskHookResponse {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision: 'allow'
    updatedInput: {
      questions: AskQuestionItem[]
      answers: Record<string, string>
      annotations?: Record<string, { preview?: string; notes?: string }>
    }
  }
}

/** Pending AskUserQuestion request waiting for dashboard answer */
interface PendingAskRequest {
  resolve: (response: AskHookResponse | null) => void
  timer: ReturnType<typeof setTimeout>
  questions: AskQuestionItem[]
}

/** Map of toolUseId -> pending ask request resolver */
const pendingAskRequests = new Map<string, PendingAskRequest>()

/** Resolve a pending AskUserQuestion request with the user's answer (or null for skip/timeout) */
export function resolveAskRequest(
  toolUseId: string,
  answers?: Record<string, string>,
  annotations?: Record<string, { preview?: string; notes?: string }>,
  skip?: boolean,
): boolean {
  const pending = pendingAskRequests.get(toolUseId)
  if (!pending) return false

  clearTimeout(pending.timer)
  pendingAskRequests.delete(toolUseId)

  if (skip || !answers) {
    pending.resolve(null) // Fall through to terminal UI
  } else {
    pending.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          questions: pending.questions,
          answers,
          ...(annotations && { annotations }),
        },
      },
    })
  }
  return true
}

const ASK_TIMEOUT_MS = 90_000 // 90s -- must be under curl's 120s --max-time

export interface LocalServerOptions {
  sessionId: string
  mcpEnabled: boolean
  onHookEvent: (event: HookEvent) => void
  onNotify?: (message: string, title?: string) => void
  onAskQuestion?: (request: AskQuestionRequest) => void
  hasDashboardSubscribers?: () => boolean
}

/**
 * Find an available port starting from the given port
 */
async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      const server = Bun.serve({
        port,
        hostname: '127.0.0.1',
        fetch() {
          return new Response('test')
        },
      })
      server.stop()
      return port
    } catch {
      // Port in use, try next
    }
  }
  throw new Error('No available port found')
}

/**
 * Create and start the local HTTP server for hook callbacks
 */
export async function startLocalServer(options: LocalServerOptions): Promise<{ server: HttpServer; port: number }> {
  const { sessionId, mcpEnabled, onHookEvent, onNotify, onAskQuestion, hasDashboardSubscribers } = options

  const port = await findAvailablePort(19000 + Math.floor(Math.random() * 1000))

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1', // loopback only -- NEVER bind 0.0.0.0
    idleTimeout: 255, // max value (seconds) -- MCP SSE streams need long-lived connections
    async fetch(req) {
      const url = new URL(req.url)

      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response('ok', { status: 200 })
      }

      // Notify endpoint: POST /notify - send push notification via concentrator
      if (req.method === 'POST' && url.pathname === '/notify') {
        try {
          const body = (await req.json()) as Record<string, unknown>
          const message = typeof body.message === 'string' ? body.message : ''
          const title = typeof body.title === 'string' ? body.title : undefined
          if (!message.trim()) {
            return new Response(JSON.stringify({ error: 'message is required' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          onNotify?.(message.trim(), title?.trim())
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        } catch {
          return new Response(JSON.stringify({ error: 'invalid JSON' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }

      // AskUserQuestion endpoint: POST /hook/AskUserQuestion
      // This is the long-timeout hook (120s curl). Blocks until dashboard answers or timeout.
      if (req.method === 'POST' && url.pathname === '/hook/AskUserQuestion') {
        try {
          const body = await req.text()
          const data = body.trim() ? (JSON.parse(body) as Record<string, unknown>) : {}

          // Safety guard: only block for actual AskUserQuestion tool calls.
          // If CC's `if` field isn't supported (pre-2.1.85) or doesn't filter,
          // this endpoint may fire for ALL PreToolUse events. Return fast for non-matches.
          if (data.tool_name !== 'AskUserQuestion') {
            return new Response(null, { status: 200 })
          }

          const toolInput = data.tool_input as Record<string, unknown> | undefined
          const toolUseId = (data.tool_use_id as string) || `ask_${Date.now()}`
          const questions = (toolInput?.questions as AskQuestionItem[]) || []

          // No dashboard? Return immediately -- CC falls through to terminal UI
          if (!hasDashboardSubscribers?.()) {
            return new Response(null, { status: 200 })
          }

          // Forward to dashboard and block until answer or timeout
          const hookResponse = await new Promise<AskHookResponse | null>(resolve => {
            const timer = setTimeout(() => {
              pendingAskRequests.delete(toolUseId)
              resolve(null) // Timeout -- fall through to terminal
            }, ASK_TIMEOUT_MS)

            pendingAskRequests.set(toolUseId, { resolve, timer, questions })

            // Notify the wrapper to forward to concentrator -> dashboard
            onAskQuestion?.({
              type: 'ask_question',
              sessionId,
              toolUseId,
              questions,
            })
          })

          if (hookResponse) {
            return new Response(JSON.stringify(hookResponse), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          // null = skip/timeout, return empty 200
          return new Response(null, { status: 200 })
        } catch {
          return new Response(null, { status: 200 }) // Don't block CC on errors
        }
      }

      // Hook event endpoint: POST /hook/:eventType
      if (req.method === 'POST' && url.pathname.startsWith('/hook/')) {
        const eventType = url.pathname.slice(6) as HookEventType // Remove "/hook/"
        const reqSessionId = req.headers.get('X-Session-Id')

        // Validate session ID
        if (reqSessionId && reqSessionId !== sessionId) {
          return new Response('Session ID mismatch', { status: 403 })
        }

        try {
          const body = await req.text()
          let data: HookEventData

          if (body.trim()) {
            data = JSON.parse(body) as HookEventData
          } else {
            data = { session_id: sessionId }
          }

          // Extract Claude's session_id from data if present, otherwise use internal
          const claudeSessionId = (data as Record<string, unknown>).session_id
          const effectiveSessionId = typeof claudeSessionId === 'string' ? claudeSessionId : sessionId

          const event: HookEvent = {
            type: 'hook',
            sessionId: effectiveSessionId,
            hookEvent: eventType,
            timestamp: Date.now(),
            data,
          }

          onHookEvent(event)

          return new Response(null, { status: 200 })
        } catch (_error) {
          // Hook processing error -- silently return 500
          return new Response('Error processing hook', { status: 500 })
        }
      }

      // MCP Streamable HTTP endpoint for channel communication
      if (mcpEnabled && (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))) {
        return handleMcpRequest(req)
      }

      return new Response('Not found', { status: 404 })
    },
  })

  return { server, port }
}

/**
 * Stop the local server
 */
export function stopLocalServer(server: HttpServer): void {
  server.stop(true)
}
