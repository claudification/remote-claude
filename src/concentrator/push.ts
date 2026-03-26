/**
 * Web Push Notification support
 * Manages VAPID keys, push subscriptions, and sending notifications
 */

import webpush from 'web-push'

interface PushSubscriptionData {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
}

interface StoredSubscription {
  subscription: PushSubscriptionData
  createdAt: number
  userAgent?: string
}

let vapidConfigured = false
const subscriptions = new Map<string, StoredSubscription>() // keyed by endpoint

export interface PushConfig {
  vapidPublicKey: string
  vapidPrivateKey: string
  vapidSubject?: string // mailto: or https: URL
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

export function addSubscription(sub: PushSubscriptionData, userAgent?: string): void {
  subscriptions.set(sub.endpoint, {
    subscription: sub,
    createdAt: Date.now(),
    userAgent,
  })
}

export function removeSubscription(endpoint: string): void {
  subscriptions.delete(endpoint)
}

export function getSubscriptionCount(): number {
  return subscriptions.size
}

export interface PushPayload {
  title: string
  body: string
  sessionId?: string
  tag?: string // dedup key - same tag replaces previous notification
  data?: Record<string, unknown>
}

export async function sendPushToAll(payload: PushPayload): Promise<{ sent: number; failed: number }> {
  if (!vapidConfigured) return { sent: 0, failed: 0 }

  const jsonPayload = JSON.stringify(payload)
  let sent = 0
  let failed = 0
  const staleEndpoints: string[] = []

  const promises = Array.from(subscriptions.values()).map(async ({ subscription }) => {
    try {
      await webpush.sendNotification(subscription, jsonPayload, {
        TTL: 60, // seconds
        urgency: 'high',
      })
      sent++
    } catch (error: unknown) {
      // 404 or 410 = subscription expired/unsubscribed
      const statusCode = (error as Record<string, unknown>)?.statusCode
      if (statusCode === 404 || statusCode === 410) {
        staleEndpoints.push(subscription.endpoint)
      }
      failed++
    }
  })

  await Promise.all(promises)

  // Clean up stale subscriptions
  for (const endpoint of staleEndpoints) {
    subscriptions.delete(endpoint)
  }

  return { sent, failed }
}
