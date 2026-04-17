/**
 * Dashboard spawn helper -- sends `spawn_request` over the WebSocket and
 * awaits the matching `spawn_request_ack`. jobId correlates the request
 * with the ack AND the per-launch progress events (`launch_log`, `job_complete`,
 * `job_failed`) broadcast on the same socket.
 */

import type { SpawnRequestAck } from '@shared/protocol'
import type { SpawnRequest } from '@shared/spawn-schema'
import { wsSend } from './use-sessions'

export type SpawnAckResult =
  | { ok: true; wrapperId: string; jobId: string; tmuxSession?: string }
  | { ok: false; error: string }

// Module-level pending ack registry (jobId -> resolver).
// Populated by sendSpawnRequest, drained by handleSpawnRequestAck (from use-websocket).
const pendingAcks = new Map<string, (ack: SpawnRequestAck) => void>()

/**
 * Called from the WS message loop when a spawn_request_ack arrives.
 * Resolves the pending promise for the matching jobId (if any).
 */
export function handleSpawnRequestAck(ack: SpawnRequestAck): void {
  if (!ack.jobId) return
  const resolver = pendingAcks.get(ack.jobId)
  if (!resolver) return
  pendingAcks.delete(ack.jobId)
  resolver(ack)
}

/**
 * Send a spawn request and wait for the server ack. Throws via resolve() the
 * error path if the ack times out or the WS is not connected.
 */
export function sendSpawnRequest(req: SpawnRequest, timeoutMs = 15000): Promise<SpawnAckResult> {
  return new Promise(resolve => {
    const jobId = req.jobId ?? crypto.randomUUID()

    const timer = globalThis.setTimeout(() => {
      pendingAcks.delete(jobId)
      resolve({ ok: false, error: 'Spawn request timed out' })
    }, timeoutMs)

    pendingAcks.set(jobId, ack => {
      globalThis.clearTimeout(timer)
      if (ack.ok && ack.wrapperId) {
        resolve({ ok: true, wrapperId: ack.wrapperId, jobId, tmuxSession: ack.tmuxSession })
      } else {
        resolve({ ok: false, error: ack.error || 'Spawn failed' })
      }
    })

    const sent = wsSend('spawn_request', { ...req, jobId })
    if (!sent) {
      pendingAcks.delete(jobId)
      globalThis.clearTimeout(timer)
      resolve({ ok: false, error: 'WebSocket not connected' })
    }
  })
}
