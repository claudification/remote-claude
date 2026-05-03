/**
 * Local HTTP Server
 * Receives hook callbacks from claude via curl POST
 * Optionally serves MCP Streamable HTTP endpoint for channel input
 */

import type { Server } from 'bun'
import type { AskQuestionItem, AskQuestionRequest, HookEvent, HookEventData, HookEventType } from '../shared/protocol'
import { handleMcpRequest } from './mcp-channel'

let debugFn: (msg: string) => void = () => {}
export function setLocalServerDebug(fn: (msg: string) => void) {
  debugFn = fn
}

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
const MAX_PENDING_ASK = 20

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
  conversationId: string
  mcpEnabled: boolean
  onHookEvent: (event: HookEvent) => void
  onNotify?: (message: string, title?: string) => void
  onAskQuestion?: (request: AskQuestionRequest) => void
  /** Fired when a queued ask request times out -- gives the wrapper a chance
   *  to clear it from the reconnect registry so a stale prompt isn't re-shown. */
  onAskTimeout?: (toolUseId: string) => void
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
  const { conversationId, mcpEnabled, onHookEvent, onNotify, onAskQuestion, onAskTimeout, hasDashboardSubscribers } =
    options

  // Derive port deterministically from conversation/wrapper ID so it survives restarts.
  // CC's hook settings bake in the port at launch time - if the wrapper restarts
  // with a different port, hooks silently fail (curl to dead port, || true hides it).
  const hash = conversationId.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
  const port = await findAvailablePort(19000 + (Math.abs(hash) % 900))

  debugFn(
    `[server] Starting local server on port ${port} (conversationId=${conversationId.slice(0, 8)}, hash=${Math.abs(hash) % 900})`,
  )

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1', // loopback only -- NEVER bind 0.0.0.0
    idleTimeout: 255, // max value (seconds) -- MCP SSE streams need long-lived connections
    async fetch(req) {
      try {
        const url = new URL(req.url)

        // Health check endpoint
        if (url.pathname === '/health') {
          return new Response('ok', { status: 200 })
        }

        // Notify endpoint: POST /notify - send push notification via broker
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

            // Evict oldest pending request if at capacity (prevents unbounded growth)
            if (pendingAskRequests.size >= MAX_PENDING_ASK) {
              const oldest = pendingAskRequests.keys().next().value
              if (oldest) {
                const stale = pendingAskRequests.get(oldest)
                if (stale) {
                  clearTimeout(stale.timer)
                  stale.resolve(null)
                  pendingAskRequests.delete(oldest)
                }
              }
            }

            // Forward to dashboard and block until answer or timeout
            const hookResponse = await new Promise<AskHookResponse | null>(resolve => {
              const timer = setTimeout(() => {
                pendingAskRequests.delete(toolUseId)
                onAskTimeout?.(toolUseId)
                resolve(null) // Timeout -- fall through to terminal
              }, ASK_TIMEOUT_MS)

              pendingAskRequests.set(toolUseId, { resolve, timer, questions })

              // Notify the wrapper to forward to broker -> dashboard
              onAskQuestion?.({
                type: 'ask_question',
                conversationId,
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

          // Validate conversation ID (X-Session-Id header carries the conversation ID)
          if (reqSessionId && reqSessionId !== conversationId) {
            return new Response('Session ID mismatch', { status: 403 })
          }

          try {
            const body = await req.text()
            let data: HookEventData

            if (body.trim()) {
              data = JSON.parse(body) as HookEventData
            } else {
              data = { session_id: conversationId }
            }

            // Extract Claude's session_id from data if present, otherwise use conversation ID
            const claudeSessionId = (data as Record<string, unknown>).session_id
            const effectiveSessionId = typeof claudeSessionId === 'string' ? claudeSessionId : conversationId

            const event: HookEvent = {
              type: 'hook',
              conversationId: effectiveSessionId,
              hookEvent: eventType,
              timestamp: Date.now(),
              data,
            }

            try {
              onHookEvent(event)
              debugFn(`[hook] ${eventType} received (sid=${effectiveSessionId.slice(0, 8)})`)
            } catch (err) {
              debugFn(`[hook] ${eventType} callback error: ${err instanceof Error ? err.message : err}`)
            }

            return new Response(null, { status: 200 })
          } catch (parseErr) {
            debugFn(`[hook] ${eventType} parse error: ${parseErr instanceof Error ? parseErr.message : parseErr}`)
            return new Response('Error processing hook', { status: 500 })
          }
        }

        // MCP Streamable HTTP endpoint for channel communication
        if (mcpEnabled && (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))) {
          try {
            return await handleMcpRequest(req)
          } catch {
            // Swallow MCP errors - never crash the local server
            return new Response('MCP error', { status: 500 })
          }
        }

        return new Response('Not found', { status: 404 })
      } catch {
        // Top-level fetch handler error - swallow to prevent process crash
        return new Response('Internal error', { status: 500 })
      }
    },
  })

  return { server, port }
}

/**
 * Check if there are pending ask requests waiting for dashboard answers.
 */
export function hasPendingAskRequests(): boolean {
  return pendingAskRequests.size > 0
}

/**
 * Stop the local server and clean up all pending ask requests
 */
export function stopLocalServer(server: HttpServer): void {
  // Resolve all pending ask requests so their Promises don't leak
  for (const [_id, pending] of pendingAskRequests) {
    clearTimeout(pending.timer)
    pending.resolve(null)
  }
  pendingAskRequests.clear()
  server.stop(true)
}
