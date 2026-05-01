import type { ServerWebSocket } from 'bun'
import type { UserGrant } from '../permissions'
import { resolvePermissions } from '../permissions'
import type { ControlPanelMessage } from './types'

export interface BroadcastDeps {
  dashboardSubscribers: Set<ServerWebSocket<unknown>>
  stampAndBuffer: (message: unknown) => string
  recordTraffic: (direction: 'in' | 'out', bytes: number) => void
  getSubscriberEntry: (ws: ServerWebSocket<unknown>) => { id: number } | undefined
}

export function broadcast(deps: BroadcastDeps, message: ControlPanelMessage): void {
  const json = deps.stampAndBuffer(message)
  for (const ws of deps.dashboardSubscribers) {
    try {
      ws.send(json)
      deps.recordTraffic('out', json.length)
    } catch (err) {
      const subInfo = deps.getSubscriberEntry(ws)
      console.error(
        `[broadcast] Send failed to ${subInfo?.id || 'unknown'}: ${err instanceof Error ? err.message : err}`,
      )
      deps.dashboardSubscribers.delete(ws)
    }
  }
}

export function broadcastSessionScoped(deps: BroadcastDeps, message: ControlPanelMessage, project: string): void {
  const json = deps.stampAndBuffer(message)
  for (const ws of deps.dashboardSubscribers) {
    try {
      const grants = (ws.data as { grants?: UserGrant[] }).grants
      if (grants) {
        const { permissions } = resolvePermissions(grants, project)
        if (!permissions.has('chat:read')) continue
      }
      ws.send(json)
      deps.recordTraffic('out', json.length)
    } catch (err) {
      const subInfo = deps.getSubscriberEntry(ws)
      console.error(
        `[broadcast] Send failed to ${subInfo?.id || 'unknown'}: ${err instanceof Error ? err.message : err}`,
      )
      deps.dashboardSubscribers.delete(ws)
    }
  }
}
