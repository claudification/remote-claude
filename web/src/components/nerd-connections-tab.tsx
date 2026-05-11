/**
 * Connections tab for Details for Nerds.
 *
 * Lazy-loaded -- imports ua-parser-js, which we don't want in the main bundle.
 * Polls /api/connections at 1s intervals while mounted. Admin-only on the
 * server side; non-admin viewers see a 403 placeholder.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { UAParser } from 'ua-parser-js'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { ConnectionInfo, ConnectionRole } from '@/lib/types'
import { cn } from '@/lib/utils'

const ROLE_ORDER: ConnectionRole[] = ['sentinel', 'agent-host', 'gateway', 'web', 'share', 'unknown']

const ROLE_LABEL: Record<ConnectionRole, string> = {
  sentinel: 'sentinel',
  'agent-host': 'agent',
  gateway: 'gateway',
  web: 'web',
  share: 'share',
  unknown: '?',
}

const ROLE_BADGE_CLASS: Record<ConnectionRole, string> = {
  sentinel: 'bg-success/15 text-success border-success/30',
  'agent-host': 'bg-accent/15 text-accent border-accent/30',
  gateway: 'bg-info/15 text-info border-info/30',
  web: 'bg-primary/15 text-primary border-primary/30',
  share: 'bg-comment/15 text-comment border-comment/30',
  unknown: 'bg-muted text-comment border-muted',
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}K`
  return `${(b / (1024 * 1024)).toFixed(1)}M`
}

function formatSince(connectedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - connectedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${sec % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function parseUA(ua: string | undefined): string {
  if (!ua) return '—'
  try {
    const { browser, os } = UAParser(ua)
    const b = browser.name || 'unknown'
    const o = os.name || ''
    return o ? `${b} -- ${o}` : b
  } catch {
    return ua.slice(0, 40)
  }
}

function RoleBadge({ role }: { role: ConnectionRole }) {
  return (
    <span
      className={cn(
        'inline-block px-1.5 py-0 text-[9px] uppercase tracking-wider border rounded',
        ROLE_BADGE_CLASS[role],
      )}
    >
      {ROLE_LABEL[role]}
    </span>
  )
}

function ConnectionRow({ conn, now, onKill }: { conn: ConnectionInfo; now: number; onKill: () => void }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <div
        className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto_auto] items-center gap-2 py-1 px-1 text-[10px] border-b border-primary/8 hover:bg-surface-inset/50"
        style={{ gridTemplateColumns: 'auto minmax(0,1fr) 120px 130px 70px 50px 90px 36px 16px' }}
      >
        <RoleBadge role={conn.role} />
        <span className="truncate text-foreground" title={conn.identity}>
          {conn.identity}
        </span>
        <span className="text-comment tabular-nums truncate" title={conn.remoteAddr}>
          {conn.remoteAddr || '—'}
        </span>
        <span className="text-comment truncate" title={conn.userAgent || ''}>
          {parseUA(conn.userAgent)}
        </span>
        <span className="text-comment tabular-nums">{formatSince(conn.connectedAt, now)}</span>
        <span className="text-comment tabular-nums text-right">{conn.channelCount > 0 ? conn.channelCount : '—'}</span>
        <span className="text-comment tabular-nums text-right">
          {formatBytes(conn.bytesIn)}/{formatBytes(conn.bytesOut)}
        </span>
        <span className="text-comment tabular-nums text-right">{conn.protocolVersion ?? '—'}</span>
        <button
          type="button"
          onClick={onKill}
          className="text-red-400/70 hover:text-red-300 text-[11px] leading-none w-4 h-4 flex items-center justify-center"
          aria-label="Close connection"
          title="Close connection"
        >
          ×
        </button>
      </div>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="text-[9px] text-comment hover:text-foreground px-1 -mt-0.5 mb-1 self-start"
      >
        {expanded ? '▾' : '▸'} details
      </button>
      {expanded && (
        <div className="bg-surface-inset/30 border-l-2 border-primary/20 px-2 py-1 mb-1 -mt-1 text-[10px] space-y-0.5">
          <div>
            <span className="text-comment">conn id:</span> <span className="text-foreground">{conn.connectionId}</span>
          </div>
          {conn.hostname && (
            <div>
              <span className="text-comment">hostname:</span> <span className="text-foreground">{conn.hostname}</span>
            </div>
          )}
          {conn.conversationId && (
            <div>
              <span className="text-comment">conversation:</span>{' '}
              <span className="text-foreground">{conn.conversationId}</span>
            </div>
          )}
          {conn.project && (
            <div>
              <span className="text-comment">project:</span> <span className="text-foreground">{conn.project}</span>
            </div>
          )}
          {conn.sentinelId && (
            <div>
              <span className="text-comment">sentinelId:</span>{' '}
              <span className="text-foreground">{conn.sentinelId}</span>
            </div>
          )}
          {conn.gatewayType && (
            <div>
              <span className="text-comment">gateway:</span>{' '}
              <span className="text-foreground">
                {conn.gatewayType}
                {conn.gatewayId ? ` (${conn.gatewayId})` : ''}
              </span>
            </div>
          )}
          {conn.userAgent && (
            <div>
              <span className="text-comment">UA:</span>{' '}
              <span className="text-foreground break-all">{conn.userAgent}</span>
            </div>
          )}
          <div>
            <span className="text-comment">msgs:</span> {conn.msgsIn} in / {conn.msgsOut} out --{' '}
            <span className="text-comment">bytes:</span> {conn.bytesIn} in / {conn.bytesOut} out
          </div>
          {conn.channels && conn.channels.length > 0 && (
            <div>
              <span className="text-comment">channels:</span>
              <ul className="ml-3 mt-0.5 font-mono">
                {conn.channels.map(c => (
                  <li key={`${c.channel}:${c.conversationId}`}>
                    {c.channel} <span className="text-comment">/</span> {c.conversationId.slice(0, 8)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  )
}

type Filter = 'all' | ConnectionRole

export default function ConnectionsTab() {
  const [connections, setConnections] = useState<ConnectionInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [now, setNow] = useState(() => Date.now())
  const [killTarget, setKillTarget] = useState<ConnectionInfo | null>(null)

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch('/api/connections', { credentials: 'same-origin' })
      if (!res.ok) {
        setError(
          res.status === 403 ? 'Admin only -- you do not have permission to view connections.' : `HTTP ${res.status}`,
        )
        return
      }
      const data = (await res.json()) as { connections: ConnectionInfo[] }
      setConnections(data.connections)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed')
    }
  }, [])

  useEffect(() => {
    fetchConnections()
    const tick = setInterval(fetchConnections, 1000)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(tick)
      clearInterval(clock)
    }
  }, [fetchConnections])

  const grouped = useMemo(() => {
    const filtered = filter === 'all' ? connections : connections.filter(c => c.role === filter)
    const groups = new Map<ConnectionRole, ConnectionInfo[]>()
    for (const role of ROLE_ORDER) groups.set(role, [])
    for (const c of filtered) {
      const list = groups.get(c.role) ?? []
      list.push(c)
      groups.set(c.role, list)
    }
    for (const list of groups.values()) list.sort((a, b) => b.connectedAt - a.connectedAt)
    return groups
  }, [connections, filter])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: connections.length }
    for (const role of ROLE_ORDER) c[role] = 0
    for (const conn of connections) c[conn.role] = (c[conn.role] || 0) + 1
    return c
  }, [connections])

  async function doKill(connId: string) {
    try {
      await fetch(`/api/connections/${encodeURIComponent(connId)}/close`, {
        method: 'POST',
        credentials: 'same-origin',
      })
      setConnections(prev => prev.filter(c => c.connectionId !== connId))
    } catch {
      // next poll will reconcile
    }
  }

  const filterChips: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'all' },
    { id: 'sentinel', label: 'sentinel' },
    { id: 'agent-host', label: 'agent' },
    { id: 'gateway', label: 'gateway' },
    { id: 'web', label: 'web' },
    { id: 'share', label: 'share' },
  ]

  return (
    <div className="space-y-2">
      {/* Filter chips */}
      <div className="flex gap-1 flex-wrap">
        {filterChips.map(chip => {
          const active = filter === chip.id
          const count = counts[chip.id] ?? 0
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => setFilter(chip.id)}
              className={cn(
                'px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors',
                active
                  ? 'bg-primary/20 text-primary border-primary/40'
                  : 'text-comment border-primary/12 hover:text-foreground',
              )}
            >
              {chip.label} <span className="text-comment">({count})</span>
            </button>
          )
        })}
      </div>

      {error && <div className="text-[11px] text-red-400">{error}</div>}

      {/* Header row */}
      <div
        className="grid items-center gap-2 px-1 text-[9px] uppercase tracking-wider text-comment border-b border-primary/12 pb-1"
        style={{ gridTemplateColumns: 'auto minmax(0,1fr) 120px 130px 70px 50px 90px 36px 16px' }}
      >
        <span>role</span>
        <span>identity</span>
        <span>ip</span>
        <span>ua</span>
        <span>since</span>
        <span className="text-right">ch</span>
        <span className="text-right">in/out</span>
        <span className="text-right">v</span>
        <span />
      </div>

      {/* Rows grouped by role */}
      <div className="space-y-0">
        {ROLE_ORDER.map(role => {
          const list = grouped.get(role) ?? []
          if (list.length === 0) return null
          return list.map(conn => (
            <ConnectionRow key={conn.connectionId} conn={conn} now={now} onKill={() => setKillTarget(conn)} />
          ))
        })}
        {connections.length === 0 && !error && (
          <div className="text-[11px] text-comment py-4 text-center">No live connections</div>
        )}
      </div>

      <Dialog open={!!killTarget} onOpenChange={open => !open && setKillTarget(null)}>
        <DialogContent className="max-w-md p-4">
          <DialogTitle>Close connection?</DialogTitle>
          {killTarget && (
            <div className="text-xs text-foreground space-y-1">
              <div>
                <span className="font-mono uppercase text-comment">{killTarget.role}</span> -- {killTarget.identity}
              </div>
              <div className="text-comment text-[11px]">
                {killTarget.remoteAddr || 'unknown ip'} -- connected {formatSince(killTarget.connectedAt, now)} ago
              </div>
              <div className="text-comment text-[11px] pt-2">
                The socket will be closed immediately. Web clients usually reconnect on their own; agent hosts and
                sentinels may need manual restart.
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setKillTarget(null)}
              className="px-3 py-1 text-[11px] text-comment hover:text-foreground border border-primary/20"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (killTarget) doKill(killTarget.connectionId)
                setKillTarget(null)
              }}
              className="px-3 py-1 text-[11px] font-bold bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30"
            >
              Close connection
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
