/**
 * Channel pub/sub registry for session-store.
 *
 * Owns: channelSubscribers (forward index), subscriberRegistry (reverse index), v2Subscribers.
 * Deps injected: controlPanelSubscribers (shared mutable ref), syncStamp, recordTraffic.
 */

import type { ServerWebSocket } from 'bun'
import type { ChannelStats, SubscriberDiag, SubscriptionChannel, SubscriptionsDiag } from '../../shared/protocol'

// Shared empty set returned by getChannelSubscribers on a miss (avoids allocating a throwaway Set per call).
// Safe to share because callers only read (`.has()`, iteration); never mutate.
const EMPTY_SUBSCRIBER_SET: Set<ServerWebSocket<unknown>> = new Set()

export interface SubscriberEntry {
  id: string
  protocolVersion: number
  connectedAt: number
  channels: Map<
    string,
    {
      channel: SubscriptionChannel
      sessionId: string
      agentId?: string
      subscribedAt: number
      messagesSent: number
      bytesSent: number
      lastMessageAt: number
    }
  >
  totals: { messagesSent: number; bytesSent: number; messagesReceived: number; bytesReceived: number }
}

export interface ChannelRegistryDeps {
  controlPanelSubscribers: Set<ServerWebSocket<unknown>>
  syncStamp: (msg: unknown) => string
  recordTraffic: (direction: 'in' | 'out', bytes: number) => void
}

export interface ChannelRegistry {
  // Core pub/sub
  subscribeChannel: (
    ws: ServerWebSocket<unknown>,
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ) => void
  unsubscribeChannel: (
    ws: ServerWebSocket<unknown>,
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ) => void
  unsubscribeAllChannels: (ws: ServerWebSocket<unknown>) => void
  getChannelSubscribers: (
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ) => Set<ServerWebSocket<unknown>>
  broadcastToChannel: (channel: SubscriptionChannel, sessionId: string, message: unknown, agentId?: string) => void
  isV2Subscriber: (ws: ServerWebSocket<unknown>) => boolean
  getSubscriptionsDiag: () => SubscriptionsDiag
  // Subscriber registry management (called by addSubscriber / removeSubscriber in main factory)
  registerSubscriber: (ws: ServerWebSocket<unknown>, protocolVersion: number, idCounter: () => number) => void
  unregisterSubscriber: (ws: ServerWebSocket<unknown>) => void
  getSubscriberEntry: (ws: ServerWebSocket<unknown>) => SubscriberEntry | undefined
  // Session rekey helpers
  migrateChannels: (oldId: string, newId: string) => void
  clearSubagentChannels: (sessionId: string) => void
  // v2 set exposed for addSubscriber to check
  v2Subscribers: Set<ServerWebSocket<unknown>>
}

function channelKey(channel: SubscriptionChannel, sessionId: string, agentId?: string): string {
  return agentId ? `${channel}:${sessionId}:${agentId}` : `${channel}:${sessionId}`
}

export function createChannelRegistry(deps: ChannelRegistryDeps): ChannelRegistry {
  const { controlPanelSubscribers, syncStamp, recordTraffic } = deps

  // Forward index: channel key -> set of subscriber sockets
  const channelSubscribers = new Map<string, Set<ServerWebSocket<unknown>>>()
  // Reverse index: socket -> subscriber info
  const subscriberRegistry = new Map<ServerWebSocket<unknown>, SubscriberEntry>()
  const v2Subscribers = new Set<ServerWebSocket<unknown>>()

  function subscribeChannel(
    ws: ServerWebSocket<unknown>,
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ): void {
    const key = channelKey(channel, sessionId, agentId)
    let subs = channelSubscribers.get(key)
    if (!subs) {
      subs = new Set()
      channelSubscribers.set(key, subs)
    }
    subs.add(ws)

    const entry = subscriberRegistry.get(ws)
    if (entry) {
      entry.channels.set(key, {
        channel,
        sessionId,
        agentId,
        subscribedAt: Date.now(),
        messagesSent: 0,
        bytesSent: 0,
        lastMessageAt: 0,
      })
    }
  }

  function unsubscribeChannel(
    ws: ServerWebSocket<unknown>,
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ): void {
    const key = channelKey(channel, sessionId, agentId)
    const subs = channelSubscribers.get(key)
    if (subs) {
      subs.delete(ws)
      if (subs.size === 0) channelSubscribers.delete(key)
    }

    const entry = subscriberRegistry.get(ws)
    if (entry) entry.channels.delete(key)
  }

  function unsubscribeAllChannels(ws: ServerWebSocket<unknown>): void {
    const entry = subscriberRegistry.get(ws)
    if (!entry) return

    for (const key of entry.channels.keys()) {
      const subs = channelSubscribers.get(key)
      if (subs) {
        subs.delete(ws)
        if (subs.size === 0) channelSubscribers.delete(key)
      }
    }
    entry.channels.clear()
  }

  function getChannelSubscribers(
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ): Set<ServerWebSocket<unknown>> {
    const key = channelKey(channel, sessionId, agentId)
    return channelSubscribers.get(key) || EMPTY_SUBSCRIBER_SET
  }

  function broadcastToChannel(
    channel: SubscriptionChannel,
    sessionId: string,
    message: unknown,
    agentId?: string,
  ): void {
    const json = syncStamp(message)
    const bytes = json.length
    const sent = new Set<ServerWebSocket<unknown>>()

    // Pre-compute filtered JSON for share viewers with hideUserInput
    let filteredJson: string | null = null
    let filteredBytes = 0
    function getFilteredJson(): string {
      if (filteredJson !== null) return filteredJson
      const msg = message as { entries?: Array<{ type?: string }> }
      if (msg.entries) {
        const filtered = { ...msg, entries: msg.entries.filter(e => e.type !== 'user') }
        filteredJson = filtered.entries.length > 0 ? syncStamp(filtered) : ''
        filteredBytes = filteredJson.length
      } else {
        filteredJson = json
        filteredBytes = bytes
      }
      return filteredJson
    }

    const key = channelKey(channel, sessionId, agentId)
    const subs = channelSubscribers.get(key)
    if (subs) {
      for (const ws of subs) {
        try {
          const wsData = ws.data as { hideUserInput?: boolean }
          if (channel === 'conversation:transcript' && wsData.hideUserInput) {
            const fj = getFilteredJson()
            if (!fj) {
              sent.add(ws)
              continue
            }
            ws.send(fj)
            sent.add(ws)
            recordTraffic('out', filteredBytes)
            const entry = subscriberRegistry.get(ws)
            if (entry) {
              entry.totals.messagesSent++
              entry.totals.bytesSent += filteredBytes
              const chStats = entry.channels.get(key)
              if (chStats) {
                chStats.messagesSent++
                chStats.bytesSent += filteredBytes
                chStats.lastMessageAt = Date.now()
              }
            }
            continue
          }
          const sent_ = ws.send(json)
          if (sent_ < 0) {
            const subInfo = subscriberRegistry.get(ws)
            console.warn(
              `[broadcast] backpressure drop: ${subInfo?.id || 'unknown'} channel=${channel}:${sessionId.slice(0, 8)} bytes=${bytes}`,
            )
          }
          sent.add(ws)
          recordTraffic('out', bytes)
          const entry = subscriberRegistry.get(ws)
          if (entry) {
            entry.totals.messagesSent++
            entry.totals.bytesSent += bytes
            const chStats = entry.channels.get(key)
            if (chStats) {
              chStats.messagesSent++
              chStats.bytesSent += bytes
              chStats.lastMessageAt = Date.now()
            }
          }
        } catch (err) {
          const subInfo = subscriberRegistry.get(ws)
          console.error(
            `[broadcast] Send failed to ${subInfo?.id || 'unknown'}: ${err instanceof Error ? err.message : err}`,
          )
          subs.delete(ws)
          if (subs.size === 0) channelSubscribers.delete(key)
        }
      }
    }

    // Also send to legacy (v1) subscribers that haven't received it
    for (const ws of controlPanelSubscribers) {
      if (!sent.has(ws) && !v2Subscribers.has(ws)) {
        try {
          ws.send(json)
          recordTraffic('out', bytes)
          const entry = subscriberRegistry.get(ws)
          if (entry) {
            entry.totals.messagesSent++
            entry.totals.bytesSent += bytes
          }
        } catch (err) {
          const subInfo = subscriberRegistry.get(ws)
          console.error(
            `[broadcast] Send failed to ${subInfo?.id || 'unknown'}: ${err instanceof Error ? err.message : err}`,
          )
          controlPanelSubscribers.delete(ws)
        }
      }
    }
  }

  function isV2Subscriber(ws: ServerWebSocket<unknown>): boolean {
    return v2Subscribers.has(ws)
  }

  function getSubscriptionsDiag(): SubscriptionsDiag {
    const subscribers: SubscriberDiag[] = []
    for (const [ws, entry] of subscriberRegistry) {
      const channels: ChannelStats[] = []
      for (const ch of entry.channels.values()) {
        channels.push({
          channel: ch.channel,
          conversationId: ch.sessionId,
          agentId: ch.agentId,
          subscribedAt: ch.subscribedAt,
          messagesSent: ch.messagesSent,
          bytesSent: ch.bytesSent,
          lastMessageAt: ch.lastMessageAt,
        })
      }
      const wsData = ws.data as { userName?: string } | undefined
      subscribers.push({
        id: entry.id,
        userName: wsData?.userName,
        protocolVersion: entry.protocolVersion,
        connectedAt: entry.connectedAt,
        channels,
        totals: { ...entry.totals },
      })
    }

    const channelCounts: Record<string, number> = {}
    for (const [key, subs] of channelSubscribers) {
      const channelName = key.split(':').slice(0, 2).join(':')
      channelCounts[channelName] = (channelCounts[channelName] || 0) + subs.size
    }

    let totalBytesSent = 0
    let totalMessagesSent = 0
    for (const entry of subscriberRegistry.values()) {
      totalBytesSent += entry.totals.bytesSent
      totalMessagesSent += entry.totals.messagesSent
    }

    return {
      subscribers,
      summary: {
        totalSubscribers: controlPanelSubscribers.size,
        legacySubscribers: controlPanelSubscribers.size - v2Subscribers.size,
        v2Subscribers: v2Subscribers.size,
        channelCounts,
        totalBytesSent,
        totalMessagesSent,
      },
    }
  }

  function registerSubscriber(ws: ServerWebSocket<unknown>, protocolVersion: number, idCounter: () => number): void {
    if (protocolVersion >= 2) {
      v2Subscribers.add(ws)
    }
    subscriberRegistry.set(ws, {
      id: `ws-${idCounter()}`,
      protocolVersion,
      connectedAt: Date.now(),
      channels: new Map(),
      totals: { messagesSent: 0, bytesSent: 0, messagesReceived: 0, bytesReceived: 0 },
    })
  }

  function unregisterSubscriber(ws: ServerWebSocket<unknown>): void {
    v2Subscribers.delete(ws)
    unsubscribeAllChannels(ws)
    subscriberRegistry.delete(ws)
  }

  function getSubscriberEntry(ws: ServerWebSocket<unknown>): SubscriberEntry | undefined {
    return subscriberRegistry.get(ws)
  }

  // Migrate channel subscriptions from oldId to newId (called by rekeyConversation)
  function migrateChannels(oldId: string, newId: string): void {
    const channelTypes: SubscriptionChannel[] = [
      'conversation:events',
      'conversation:transcript',
      'conversation:tasks',
      'conversation:bg_output',
    ]
    for (const channel of channelTypes) {
      const oldKey = channelKey(channel, oldId)
      const subs = channelSubscribers.get(oldKey)
      if (!subs || subs.size === 0) continue

      const newKey = channelKey(channel, newId)
      let newSubs = channelSubscribers.get(newKey)
      if (!newSubs) {
        newSubs = new Set()
        channelSubscribers.set(newKey, newSubs)
      }

      for (const ws of subs) {
        newSubs.add(ws)
        const entry = subscriberRegistry.get(ws)
        if (entry) {
          const oldStats = entry.channels.get(oldKey)
          entry.channels.delete(oldKey)
          entry.channels.set(newKey, {
            channel,
            sessionId: newId,
            subscribedAt: oldStats?.subscribedAt || Date.now(),
            messagesSent: oldStats?.messagesSent || 0,
            bytesSent: oldStats?.bytesSent || 0,
            lastMessageAt: oldStats?.lastMessageAt || 0,
          })
        }
        try {
          ws.send(
            JSON.stringify({
              type: 'channel_ack',
              channel,
              sessionId: newId,
              status: 'subscribed',
              previousSessionId: oldId,
            }),
          )
        } catch {
          /* dead socket, will be cleaned up */
        }
      }
      channelSubscribers.delete(oldKey)
    }
  }

  // Clear subagent transcript subscriptions for a conversation (called by rekeyConversation)
  function clearSubagentChannels(sessionId: string): void {
    for (const key of channelSubscribers.keys()) {
      if (key.startsWith(`conversation:subagent_transcript:${sessionId}:`)) {
        const subs = channelSubscribers.get(key)
        if (subs) {
          for (const ws of subs) {
            const entry = subscriberRegistry.get(ws)
            if (entry) entry.channels.delete(key)
          }
        }
        channelSubscribers.delete(key)
      }
    }
  }

  return {
    subscribeChannel,
    unsubscribeChannel,
    unsubscribeAllChannels,
    getChannelSubscribers,
    broadcastToChannel,
    isV2Subscriber,
    getSubscriptionsDiag,
    registerSubscriber,
    unregisterSubscriber,
    getSubscriberEntry,
    migrateChannels,
    clearSubagentChannels,
    v2Subscribers,
  }
}
