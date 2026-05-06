/**
 * Persistent message queue: stores messages for offline/disconnected conversations.
 *
 * Keyed by target project (not conversation ID) so messages survive
 * session restarts. Backed by StoreDriver.messages (SQLite).
 */

import type { MessageStore } from './store/types'

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const MAX_QUEUE_PER_TARGET = 100

let store: MessageStore | null = null

export function initMessageQueue(messageStore: MessageStore): void {
  store = messageStore
  store.pruneExpired()
}

export function enqueue(
  targetProject: string,
  senderProject: string,
  senderName: string,
  message: Record<string, unknown>,
  targetName?: string,
): void {
  if (!store) return

  // Cap queue size per target -- drop oldest if over limit
  const count = store.countFor(targetProject)
  if (count >= MAX_QUEUE_PER_TARGET) {
    const oldest = store.dequeueFor(targetProject)
    if (oldest.length > 0) {
      // Re-enqueue all but the oldest
      for (let i = 1; i < oldest.length; i++) {
        store.enqueue({
          fromScope: oldest[i].fromScope,
          toScope: oldest[i].toScope,
          fromName: oldest[i].fromName,
          targetName: oldest[i].targetName,
          content: oldest[i].content,
          intent: oldest[i].intent,
          conversationId: oldest[i].conversationId,
          expiresAt: oldest[i].createdAt + MESSAGE_TTL_MS,
        })
      }
    }
  }

  store.enqueue({
    fromScope: senderProject,
    toScope: targetProject,
    fromName: senderName,
    targetName,
    content: JSON.stringify(message),
    expiresAt: Date.now() + MESSAGE_TTL_MS,
  })
}

export interface DrainedMessage {
  ts: number
  senderProject: string
  senderName: string
  message: Record<string, unknown>
  targetName?: string
}

/**
 * Drain pending messages for a target project.
 * If conversationName is provided, only drains messages targeted at that name
 * (or messages with no targetName -- project-level messages). Messages targeted
 * at other conversation names stay in the queue.
 */
export function drain(targetProject: string, conversationName?: string): DrainedMessage[] {
  if (!store) return []

  const messages = store.dequeueFor(targetProject, conversationName || undefined)
  return messages.map(m => ({
    ts: m.createdAt,
    senderProject: m.fromScope,
    senderName: m.fromName || m.fromScope,
    message: JSON.parse(m.content) as Record<string, unknown>,
    targetName: m.targetName,
  }))
}

export function getQueueSize(targetProject: string): number {
  if (!store) return 0
  return store.countFor(targetProject)
}
