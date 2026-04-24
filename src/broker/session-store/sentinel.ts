import type { ServerWebSocket } from 'bun'
import type { UsageUpdate } from '../../shared/protocol'
import type { DashboardMessage } from './types'

const SENTINEL_DIAG_MAX = 200

export interface SentinelConnection {
  ws: ServerWebSocket<unknown>
  sentinelId: string
  alias: string
  hostname?: string
  machineId?: string
  spawnRoot?: string
  connectedAt: number
}

export interface SentinelIdentifyInfo {
  machineId?: string
  hostname?: string
  alias?: string
  spawnRoot?: string
  sentinelId?: string
}

export interface SentinelState {
  sentinels: Map<string, SentinelConnection> // sentinelId -> live connection
  sentinelsByAlias: Map<string, string> // alias -> sentinelId (O(1) alias lookup)
  diagLog: Array<{ t: number; type: string; msg: string; args?: unknown }>
  usage: UsageUpdate | undefined
}

export function createSentinelState(): SentinelState {
  return {
    sentinels: new Map(),
    sentinelsByAlias: new Map(),
    diagLog: [],
    usage: undefined,
  }
}

export function setSentinel(
  state: SentinelState,
  ws: ServerWebSocket<unknown>,
  broadcast: (msg: DashboardMessage) => void,
  info?: SentinelIdentifyInfo,
): boolean {
  const sentinelId = info?.sentinelId || 'default'
  const alias = info?.alias || 'default'

  // Replace existing connection for this sentinel (reconnect case)
  const existing = state.sentinels.get(sentinelId)
  if (existing) {
    try {
      existing.ws.close(4409, 'Replaced by new connection')
    } catch {}
  }

  const conn: SentinelConnection = {
    ws,
    sentinelId,
    alias,
    hostname: info?.hostname,
    machineId: info?.machineId,
    spawnRoot: info?.spawnRoot,
    connectedAt: Date.now(),
  }
  state.sentinels.set(sentinelId, conn)
  state.sentinelsByAlias.set(alias, sentinelId)
  broadcast({ type: 'sentinel_status', connected: true, machineId: info?.machineId, hostname: info?.hostname })
  return true
}

export function removeSentinel(
  state: SentinelState,
  ws: ServerWebSocket<unknown>,
  broadcast: (msg: DashboardMessage) => void,
): void {
  for (const [id, conn] of state.sentinels) {
    if (conn.ws === ws) {
      state.sentinels.delete(id)
      state.sentinelsByAlias.delete(conn.alias)
      broadcast({ type: 'sentinel_status', connected: false })
      return
    }
  }
}

export function pushSentinelDiag(
  state: SentinelState,
  entry: { t: number; type: string; msg: string; args?: unknown },
): void {
  state.diagLog.push(entry)
  if (state.diagLog.length > SENTINEL_DIAG_MAX) {
    state.diagLog.splice(0, state.diagLog.length - SENTINEL_DIAG_MAX)
  }
}

export function setUsage(state: SentinelState, usage: UsageUpdate, broadcast: (msg: DashboardMessage) => void): void {
  state.usage = usage
  broadcast({ type: 'usage_update', usage } as unknown as DashboardMessage)
}
