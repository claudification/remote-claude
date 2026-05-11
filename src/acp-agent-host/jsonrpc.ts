/**
 * Minimal stdio JSON-RPC 2.0 client for the ACP agent host.
 *
 * Drives a child process that speaks JSON-RPC 2.0 framed by line breaks (the
 * format ACP uses over stdio: one JSON object per line on stdout / stdin).
 *
 * Three message kinds flow in:
 *   - Responses to client->agent calls (`id` + `result`/`error`)
 *   - Requests from agent->client       (`id` + `method`)
 *   - Notifications from agent->client  (`method` only, no `id`)
 *
 * Two flow out:
 *   - Requests we issue (`id` + `method`)
 *   - Responses to incoming agent requests (`id` + `result`/`error`)
 *
 * This module is transport-only: it knows nothing about ACP method names. The
 * higher-level host wires up handlers via `onRequest` and `onNotify`. Pure
 * module -- no Bun-specifics, no node:* imports beyond simple types -- so it
 * can be unit-tested with synthetic streams.
 */

interface JsonRpcResult {
  jsonrpc: '2.0'
  id: number | string
  result: unknown
}
interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: number | string
  error: { code: number; message: string; data?: unknown }
}
type JsonRpcResponse = JsonRpcResult | JsonRpcErrorResponse

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** What an inbound line is, after parsing. The discriminant is structural --
 *  ACP doesn't put a `type` field on the wire. */
export function classifyInbound(msg: {
  id?: unknown
  method?: unknown
  result?: unknown
  error?: unknown
}): 'response' | 'request' | 'notification' | 'invalid' {
  const hasId = msg.id !== undefined && msg.id !== null
  const hasMethod = typeof msg.method === 'string' && msg.method.length > 0
  const hasResult = msg.result !== undefined
  const hasError = msg.error !== undefined
  if (hasId && hasMethod) return 'request'
  if (hasId && (hasResult || hasError)) return 'response'
  if (!hasId && hasMethod) return 'notification'
  return 'invalid'
}

export interface JsonRpcWriter {
  /** Send a single line (object stringified + `\n`). Implementations route
   *  to the child process's stdin. */
  writeLine(text: string): void
}

export interface JsonRpcClientOptions {
  writer: JsonRpcWriter
  /** Called when an agent->client request arrives. Implementation must call
   *  `respond` or `respondError` exactly once for each. */
  onRequest: (
    req: JsonRpcRequest,
    respond: (result: unknown) => void,
    respondError: (code: number, message: string, data?: unknown) => void,
  ) => void
  /** Called for every notification from the agent. */
  onNotify: (notif: JsonRpcNotification) => void
  /** Called when an inbound line fails to parse or is structurally invalid.
   *  Useful for tracing and noisy-stream diagnostics. */
  onInvalid?: (line: string, reason: string) => void
  /** Called for every parsed inbound message and every outbound message
   *  (request, response, notification). Direction is 'send' for client->agent,
   *  'recv' for agent->client. Used by the host to write per-conversation
   *  NDJSON traffic logs without touching this transport-only module. */
  onTrace?: (dir: 'send' | 'recv', msg: object) => void
}

interface PendingCall {
  id: number
  method: string
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timeout?: ReturnType<typeof setTimeout>
}

/**
 * The client.
 *
 * Lifecycle: caller pumps inbound stream into `feed(chunk)` (raw text, may
 * straddle line boundaries -- the client buffers internally). To make calls,
 * caller does `await client.call(method, params)`. To respond to incoming
 * requests, the `onRequest` callback is given `respond`/`respondError`
 * functions.
 */
export class JsonRpcClient {
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private readonly opts: JsonRpcClientOptions

  constructor(opts: JsonRpcClientOptions) {
    this.opts = opts
  }

  /** Feed raw text from the child's stdout. May be partial; the client buffers
   *  until a full `\n`-terminated line arrives. */
  feed(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const idx = this.buffer.indexOf('\n')
      if (idx === -1) break
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      this.consumeLine(line)
    }
  }

  /** Issue a request to the agent. Resolves with the result or rejects with
   *  an Error wrapping the JSON-RPC error or a transport timeout. */
  call<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    const promise = new Promise<T>((resolve, reject) => {
      const pending: PendingCall = {
        id,
        method,
        resolve: r => resolve(r as T),
        reject,
      }
      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`JSON-RPC timeout: ${method} (${timeoutMs}ms)`))
        }, timeoutMs)
      }
      this.pending.set(id, pending)
    })
    this.opts.onTrace?.('send', req)
    this.opts.writer.writeLine(JSON.stringify(req))
    return promise
  }

  /** Send a notification (fire-and-forget; no response expected). */
  notify(method: string, params?: unknown): void {
    const n: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.opts.onTrace?.('send', n)
    this.opts.writer.writeLine(JSON.stringify(n))
  }

  /** Number of in-flight calls. Useful for tests and shutdown logic. */
  get pendingCount(): number {
    return this.pending.size
  }

  /** Reject every in-flight call with the given error. Called on stream
   *  close so awaiters don't hang forever. */
  rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      if (p.timeout) clearTimeout(p.timeout)
      try {
        p.reject(err)
      } catch {}
    }
    this.pending.clear()
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
    try {
      parsed = JSON.parse(trimmed)
    } catch (e) {
      this.opts.onInvalid?.(trimmed, `parse error: ${(e as Error).message}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.opts.onInvalid?.(trimmed, 'not an object')
      return
    }
    const kind = classifyInbound(parsed)
    if (kind === 'invalid') {
      this.opts.onInvalid?.(trimmed, 'no id+method, no id+result/error, no method-only')
      return
    }
    this.opts.onTrace?.('recv', parsed as object)
    if (kind === 'response') {
      const res = parsed as unknown as JsonRpcResponse
      if (typeof res.id !== 'number') {
        this.opts.onInvalid?.(trimmed, 'response with non-numeric id (string ids unsupported by this client)')
        return
      }
      const pending = this.pending.get(res.id)
      if (!pending) {
        this.opts.onInvalid?.(trimmed, `response for unknown id ${res.id}`)
        return
      }
      this.pending.delete(res.id)
      if (pending.timeout) clearTimeout(pending.timeout)
      if ('error' in res && res.error) {
        pending.reject(new Error(`${pending.method} rpc error ${res.error.code}: ${res.error.message}`))
      } else {
        pending.resolve((res as JsonRpcResult).result)
      }
      return
    }
    if (kind === 'request') {
      const req = parsed as unknown as JsonRpcRequest
      const respond = (result: unknown) => {
        const out: JsonRpcResult = { jsonrpc: '2.0', id: req.id, result }
        this.opts.onTrace?.('send', out)
        this.opts.writer.writeLine(JSON.stringify(out))
      }
      const respondError = (code: number, message: string, data?: unknown) => {
        const out: JsonRpcErrorResponse = {
          jsonrpc: '2.0',
          id: req.id,
          error: { code, message, ...(data !== undefined ? { data } : {}) },
        }
        this.opts.onTrace?.('send', out)
        this.opts.writer.writeLine(JSON.stringify(out))
      }
      try {
        this.opts.onRequest(req, respond, respondError)
      } catch (e) {
        respondError(-32603, `handler threw: ${(e as Error).message}`)
      }
      return
    }
    // notification
    this.opts.onNotify(parsed as unknown as JsonRpcNotification)
  }
}
