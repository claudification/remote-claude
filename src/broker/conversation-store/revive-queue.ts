/**
 * Revive queue -- buffers revive requests for offline sentinels.
 *
 * When a conversation's sentinel is offline, the revive request is queued
 * with a 10-minute timeout. On sentinel reconnect, pending requests
 * are drained and dispatched. On timeout, the request is ejected
 * with an error.
 */

const REVIVE_QUEUE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

export interface QueuedRevive {
  sentinelId: string
  sentinelAlias: string
  sessionId: string
  conversationId: string
  jobId?: string
  payload: Record<string, unknown>
  queuedAt: number
  timeoutId: ReturnType<typeof setTimeout>
}

export interface ReviveQueue {
  enqueue(entry: Omit<QueuedRevive, 'queuedAt' | 'timeoutId'>, onTimeout: (entry: QueuedRevive) => void): void
  drain(sentinelId: string): QueuedRevive[]
  remove(conversationId: string): boolean
  size(): number
}

export function createReviveQueue(): ReviveQueue {
  const queue = new Map<string, QueuedRevive>() // conversationId -> entry

  function enqueue(
    entry: Omit<QueuedRevive, 'queuedAt' | 'timeoutId'>,
    onTimeout: (entry: QueuedRevive) => void,
  ): void {
    // Remove existing entry for this conversation if re-queued
    const existing = queue.get(entry.conversationId)
    if (existing) clearTimeout(existing.timeoutId)

    const full: QueuedRevive = {
      ...entry,
      queuedAt: Date.now(),
      timeoutId: setTimeout(() => {
        queue.delete(entry.conversationId)
        onTimeout(full)
      }, REVIVE_QUEUE_TIMEOUT_MS),
    }
    queue.set(entry.conversationId, full)
  }

  function drain(sentinelId: string): QueuedRevive[] {
    const result: QueuedRevive[] = []
    for (const [convId, entry] of queue) {
      if (entry.sentinelId === sentinelId) {
        clearTimeout(entry.timeoutId)
        queue.delete(convId)
        result.push(entry)
      }
    }
    return result
  }

  function remove(conversationId: string): boolean {
    const entry = queue.get(conversationId)
    if (!entry) return false
    clearTimeout(entry.timeoutId)
    queue.delete(conversationId)
    return true
  }

  return {
    enqueue,
    drain,
    remove,
    size: () => queue.size,
  }
}
