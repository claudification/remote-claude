/**
 * Global live connection registry.
 *
 * One entry per ServerWebSocket regardless of role (web, agent-host, sentinel,
 * gateway, share). Populated at websocket.open, removed at websocket.close.
 * Used by the Connections tab in Details for Nerds and the kill-connection
 * admin endpoint.
 *
 * Per-socket inbound traffic is tallied here at the message() handler.
 * Per-socket outbound traffic for control-panel sockets is pulled from
 * subscriberRegistry.totals at snapshot time; for other roles it stays 0
 * (acceptable for v1 -- those connections rarely receive bulk data).
 */

import type { ServerWebSocket } from 'bun'
import type { ConnectionInfo, ConnectionRole } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'
import type { WsData } from './handler-context'

interface RegistryEntry {
  ws: ServerWebSocket<WsData>
  bytesIn: number
  msgsIn: number
}

const byId = new Map<string, RegistryEntry>()
const bySocket = new Map<ServerWebSocket<WsData>, RegistryEntry>()

export function registerConnection(ws: ServerWebSocket<WsData>): void {
  const id = ws.data.wsConnId
  if (!id) return
  const entry: RegistryEntry = { ws, bytesIn: 0, msgsIn: 0 }
  byId.set(id, entry)
  bySocket.set(ws, entry)
}

export function unregisterConnection(ws: ServerWebSocket<WsData>): void {
  const id = ws.data.wsConnId
  if (id) byId.delete(id)
  bySocket.delete(ws)
}

export function recordInboundForSocket(ws: ServerWebSocket<WsData>, bytes: number): void {
  const entry = bySocket.get(ws)
  if (!entry) return
  entry.bytesIn += bytes
  entry.msgsIn++
}

export function getAllConnectionEntries(): RegistryEntry[] {
  return Array.from(byId.values())
}

export function findConnectionById(connId: string): RegistryEntry | undefined {
  return byId.get(connId)
}

export function deriveRole(data: WsData): ConnectionRole {
  if (data.isSentinel || data.sentinelId) return 'sentinel'
  if (data.isGateway) return 'gateway'
  if (data.isShare) return 'share'
  if (data.isControlPanel) return 'web'
  if (data.conversationId) return 'agent-host'
  // Pre-handshake: authenticated but no role flag yet.
  // Browsers carry a userAgent; non-browser clients (rclaude, sentinels) usually don't.
  if (data.userName && data.userAgent) return 'web'
  return 'unknown'
}

function formatIdentity(data: WsData, role: ConnectionRole): string {
  switch (role) {
    case 'sentinel':
      return data.sentinelAlias
        ? `${data.sentinelAlias}${data.sentinelId ? ` (${data.sentinelId.slice(0, 8)})` : ''}`
        : data.sentinelId?.slice(0, 12) || 'sentinel'
    case 'gateway':
      return `${data.gatewayType || 'gateway'}${data.gatewayAlias ? ` (${data.gatewayAlias})` : ''}`
    case 'share':
      return data.shareToken ? `share:${data.shareToken.slice(-8)}` : 'share'
    case 'web':
      return data.userName || 'anonymous'
    case 'agent-host':
      return data.conversationId ? data.conversationId.slice(0, 12) : 'agent'
    default:
      return data.userName || 'unknown'
  }
}

export function buildConnectionInfoList(store: ConversationStore): ConnectionInfo[] {
  const out: ConnectionInfo[] = []
  for (const entry of byId.values()) {
    const ws = entry.ws
    const data = ws.data
    if (!data.wsConnId) continue
    const role = deriveRole(data)

    // Pull channel info + outbound totals from control-panel subscriber registry (web role only)
    const subEntry = store.getSubscriberEntryForWs(ws)
    const channelCount = subEntry?.channels.size ?? 0
    const channels: ConnectionInfo['channels'] = subEntry
      ? Array.from(subEntry.channels.values()).map(c => ({ channel: c.channel, conversationId: c.conversationId }))
      : undefined
    const bytesOut = subEntry?.totals.bytesSent ?? 0
    const msgsOut = subEntry?.totals.messagesSent ?? 0

    // Sentinel-specific hostname enrichment
    let hostname: string | undefined
    if (role === 'sentinel' && data.sentinelId) {
      const conn = store.getSentinelConnection(data.sentinelId)
      if (conn) hostname = conn.hostname
    }

    // Agent-host project enrichment
    let project: string | undefined
    if (role === 'agent-host' && data.conversationId) {
      const conv = store.getConversation(data.conversationId)
      project = conv?.project
    }

    out.push({
      connectionId: data.wsConnId,
      role,
      identity: formatIdentity(data, role),
      userName: data.userName,
      conversationId: data.conversationId,
      project,
      sentinelId: data.sentinelId,
      sentinelAlias: data.sentinelAlias,
      gatewayType: data.gatewayType,
      gatewayId: data.gatewayId,
      hostname,
      remoteAddr: data.remoteAddr,
      userAgent: data.userAgent,
      connectedAt: data.connectedAt ?? 0,
      channelCount,
      channels,
      bytesIn: entry.bytesIn,
      bytesOut,
      msgsIn: entry.msgsIn,
      msgsOut,
      protocolVersion: subEntry?.protocolVersion,
    })
  }
  return out
}

export function closeConnection(connId: string, reason = 'Closed by admin'): boolean {
  const entry = byId.get(connId)
  if (!entry) return false
  try {
    entry.ws.close(4000, reason)
  } catch {
    return false
  }
  return true
}
