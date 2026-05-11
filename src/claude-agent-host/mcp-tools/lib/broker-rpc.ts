/**
 * Broker RPC correlation helper.
 *
 * MCP tools that need to read broker-only state (recaps, future cross-conversation
 * queries) call brokerRpc(type, payload). The helper:
 *   - mints a requestId
 *   - sends the message via the active ws-client sender
 *   - registers a pending entry keyed by requestId
 *   - resolves when a matching response arrives via dispatchBrokerRpcResponse
 *   - rejects on timeout (default 15s) or explicit ok:false
 *
 * The ws-client routes any incoming message that carries requestId AND matches
 * one of the configured response types into dispatchBrokerRpcResponse. Unmatched
 * requestIds are ignored (stale, duplicate, or pre-rotation responses).
 */

import { randomUUID } from 'node:crypto'
import type { AgentHostMessage } from '../../../shared/protocol'

type Sender = (msg: AgentHostMessage) => void

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  type: string
}

const pending = new Map<string, Pending>()
let sendFn: Sender | null = null

export function setBrokerRpcSender(fn: Sender | null): void {
  sendFn = fn
}

export function hasBrokerRpcSender(): boolean {
  return sendFn !== null
}

export interface BrokerRpcOptions {
  timeoutMs?: number
}

export function brokerRpc<T extends Record<string, unknown> = Record<string, unknown>>(
  type: string,
  payload: Record<string, unknown> = {},
  options: BrokerRpcOptions = {},
): Promise<T> {
  const send = sendFn
  if (!send) return Promise.reject(new Error('broker not connected'))
  const timeoutMs = options.timeoutMs ?? 15_000
  const requestId = randomUUID()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`broker rpc timeout (${timeoutMs}ms) for ${type}`))
    }, timeoutMs)
    pending.set(requestId, {
      resolve: value => resolve(value as T),
      reject,
      timer,
      type,
    })
    try {
      send({ type, requestId, ...payload } as unknown as AgentHostMessage)
    } catch (err) {
      const entry = pending.get(requestId)
      if (entry) {
        clearTimeout(entry.timer)
        pending.delete(requestId)
      }
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

export function dispatchBrokerRpcResponse(msg: Record<string, unknown>): boolean {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null
  if (!requestId) return false
  const entry = pending.get(requestId)
  if (!entry) return false
  pending.delete(requestId)
  clearTimeout(entry.timer)
  if (msg.ok === false) {
    const errMsg = typeof msg.error === 'string' ? msg.error : 'broker rpc error'
    entry.reject(new Error(errMsg))
    return true
  }
  if (typeof msg.error === 'string' && msg.ok === undefined) {
    entry.reject(new Error(msg.error))
    return true
  }
  entry.resolve(msg)
  return true
}

export function clearBrokerRpcPending(reason = 'broker disconnected'): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
    pending.delete(id)
  }
}

export function brokerRpcPendingCount(): number {
  return pending.size
}

/** Internal -- test-only access to wipe sender + pending state between cases. */
export function _resetBrokerRpc(): void {
  for (const [, entry] of pending) clearTimeout(entry.timer)
  pending.clear()
  sendFn = null
}
