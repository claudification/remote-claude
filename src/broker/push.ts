/**
 * Web Push Notification support
 * Subscriptions stored per-user in auth.json.
 * Sending checks grants (canNotifications) before delivery.
 */

import webpush from 'web-push'
import { getAllUsers, getUser, type PushSubscriptionEntry, save as saveAuth } from './auth'
import { resolvePermissions } from './permissions'

export type { PushSubscriptionEntry }

export type PushSubscriptionData = PushSubscriptionEntry['subscription']

let vapidConfigured = false

export interface PushConfig {
  vapidPublicKey: string
  vapidPrivateKey: string
  vapidSubject?: string
}

export function initPush(config: PushConfig): void {
  webpush.setVapidDetails(
    config.vapidSubject || 'mailto:push@rclaude.local',
    config.vapidPublicKey,
    config.vapidPrivateKey,
  )
  vapidConfigured = true
}

export function isPushConfigured(): boolean {
  return vapidConfigured
}

export function getVapidPublicKey(config: PushConfig): string {
  return config.vapidPublicKey
}

// ─── Per-user subscription management ─────────────────────────────

export function addSubscription(userName: string, sub: PushSubscriptionData, userAgent?: string): void {
  const user = getUser(userName)
  if (!user) return
  if (!user.pushSubscriptions) user.pushSubscriptions = []
  // Dedup by endpoint
  const existing = user.pushSubscriptions.findIndex(s => s.subscription.endpoint === sub.endpoint)
  if (existing >= 0) {
    user.pushSubscriptions[existing] = { subscription: sub, createdAt: Date.now(), userAgent }
  } else {
    user.pushSubscriptions.push({ subscription: sub, createdAt: Date.now(), userAgent })
  }
  saveAuth()
}

export function removeSubscription(userName: string, endpoint: string): void {
  const user = getUser(userName)
  if (!user?.pushSubscriptions) return
  user.pushSubscriptions = user.pushSubscriptions.filter(s => s.subscription.endpoint !== endpoint)
  saveAuth()
}

export function getSubscriptionCount(): number {
  let count = 0
  for (const user of getAllUsers()) {
    count += user.pushSubscriptions?.length || 0
  }
  return count
}

// ─── Sending ──────────────────────────────────────────────────────

export interface PushPayload {
  title: string
  body: string
  conversationId?: string
  sessionProject?: string
  tag?: string
  data?: Record<string, unknown>
}

/** Send push to all users who have notifications permission for the conversation's project */
export async function sendPushToAll(payload: PushPayload): Promise<{ sent: number; failed: number }> {
  if (!vapidConfigured) return { sent: 0, failed: 0 }

  const jsonPayload = JSON.stringify(payload)
  let sent = 0
  let failed = 0
  const staleEntries: Array<{ userName: string; endpoint: string }> = []

  for (const user of getAllUsers()) {
    if (user.revoked || !user.pushSubscriptions?.length) continue

    // Check if user has notifications permission for this conversation's project
    if (payload.sessionProject) {
      const { permissions } = resolvePermissions(user.grants, payload.sessionProject)
      if (!permissions.has('notifications')) continue
    }

    for (const entry of user.pushSubscriptions) {
      try {
        await webpush.sendNotification(entry.subscription, jsonPayload, {
          TTL: 60,
          urgency: 'high',
        })
        sent++
      } catch (error: unknown) {
        const statusCode = (error as Record<string, unknown>)?.statusCode
        if (statusCode === 404 || statusCode === 410) {
          staleEntries.push({ userName: user.name, endpoint: entry.subscription.endpoint })
        }
        failed++
      }
    }
  }

  // Clean up stale subscriptions (404/410 = endpoint no longer valid)
  if (staleEntries.length > 0) {
    for (const { userName, endpoint } of staleEntries) {
      console.log(`[push] Removing stale subscription for "${userName}" (endpoint gone: ${endpoint.slice(0, 60)}...)`)
      removeSubscription(userName, endpoint)
    }
  }

  return { sent, failed }
}

/** Send push to a specific user's devices */
export async function sendPushToUser(
  userName: string,
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> {
  if (!vapidConfigured) return { sent: 0, failed: 0 }

  const user = getUser(userName)
  if (!user?.pushSubscriptions?.length) return { sent: 0, failed: 0 }

  const jsonPayload = JSON.stringify(payload)
  let sent = 0
  let failed = 0
  const staleEndpoints: string[] = []

  for (const entry of user.pushSubscriptions) {
    try {
      await webpush.sendNotification(entry.subscription, jsonPayload, {
        TTL: 60,
        urgency: 'high',
      })
      sent++
    } catch (error: unknown) {
      const statusCode = (error as Record<string, unknown>)?.statusCode
      if (statusCode === 404 || statusCode === 410) {
        staleEndpoints.push(entry.subscription.endpoint)
      }
      failed++
    }
  }

  for (const endpoint of staleEndpoints) {
    console.log(`[push] Removing stale subscription for "${userName}" (endpoint gone: ${endpoint.slice(0, 60)}...)`)
    removeSubscription(userName, endpoint)
  }

  return { sent, failed }
}
