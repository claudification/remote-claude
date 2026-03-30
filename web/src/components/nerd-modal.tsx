/**
 * Details for Nerds - tabbed diagnostic modal
 * Tabs: Traffic (WS stats), Cache (LIFO session cache), Subscriptions, Debug Log
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { getRates, subscribe as subscribeStats } from '@/hooks/ws-stats'
import { clearLog, copyLogText, getLogEntries, type LogEntry, subscribeLog } from '@/lib/debug-log'
import { cn } from '@/lib/utils'

interface ServerStats {
  uptime: number
  sessions: { total: number; active: number; idle: number; ended: number }
  connections: { total: number; legacy: number; v2: number }
  traffic: {
    in: { messagesPerSec: number; bytesPerSec: number }
    out: { messagesPerSec: number; bytesPerSec: number }
  }
  channels: Record<string, number>
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatBytes(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

function formatMemory(entries: number): string {
  // Rough estimate: ~2KB per transcript entry average
  const kb = entries * 2
  if (kb < 1024) return `~${kb}KB`
  return `~${(kb / 1024).toFixed(1)}MB`
}

function StatRow({ label, value, accent, dim }: { label: string; value: string; accent?: boolean; dim?: boolean }) {
  const valueColor = accent ? 'text-[#9ece6a]' : dim ? 'text-[#565f89]' : 'text-[#7aa2f7]'
  return (
    <div className="flex justify-between py-0.5 border-b border-[#33467c]/20">
      <span className="text-[#a9b1d6]">{label}</span>
      <span className={`${valueColor} tabular-nums`}>{value}</span>
    </div>
  )
}

type Tab = 'traffic' | 'cache' | 'log'

function TrafficTab({ serverStats, fetchError }: { serverStats: ServerStats | null; fetchError: string | null }) {
  const clientRates = useSyncExternalStore(subscribeStats, getRates)
  const channelEntries = serverStats ? Object.entries(serverStats.channels) : []

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Client (browser WS)</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          <StatRow label="msg in" value={`${clientRates.msgInPerSec.toFixed(1)}/s`} />
          <StatRow label="msg out" value={`${clientRates.msgOutPerSec.toFixed(1)}/s`} />
          <StatRow label="bytes in" value={formatBytes(clientRates.bytesInPerSec)} />
          <StatRow label="bytes out" value={formatBytes(clientRates.bytesOutPerSec)} />
        </div>
      </div>

      {fetchError && <div className="text-[11px] text-red-400">Server fetch error: {fetchError}</div>}

      {serverStats && (
        <>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Server</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <StatRow label="uptime" value={formatUptime(serverStats.uptime)} />
              <StatRow label="sessions" value={String(serverStats.sessions.total)} />
              <StatRow label="active" value={String(serverStats.sessions.active)} accent />
              <StatRow label="connections" value={String(serverStats.connections.total)} />
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Server Traffic</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <StatRow label="msg in" value={`${serverStats.traffic.in.messagesPerSec}/s`} />
              <StatRow label="msg out" value={`${serverStats.traffic.out.messagesPerSec}/s`} />
              <StatRow label="bytes in" value={formatBytes(serverStats.traffic.in.bytesPerSec)} />
              <StatRow label="bytes out" value={formatBytes(serverStats.traffic.out.bytesPerSec)} />
            </div>
          </div>

          {channelEntries.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">
                Channels ({channelEntries.length})
              </div>
              <div className="max-h-32 overflow-y-auto">
                {channelEntries.map(([name, count]) => (
                  <StatRow key={name} label={name} value={String(count)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function CacheTab() {
  const mru = useSessionsStore(s => s.sessionMru)
  const sessions = useSessionsStore(s => s.sessions)
  const transcripts = useSessionsStore(s => s.transcripts)
  const events = useSessionsStore(s => s.events)
  const selected = useSessionsStore(s => s.selectedSessionId)
  const prefs = useSessionsStore(s => s.dashboardPrefs)

  const cachedIds = Object.keys(transcripts).filter(id => (transcripts[id]?.length ?? 0) > 0)
  const totalEntries = cachedIds.reduce((sum, id) => sum + (transcripts[id]?.length ?? 0), 0)
  const totalEvents = cachedIds.reduce((sum, id) => sum + (events[id]?.length ?? 0), 0)

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">LIFO Cache Settings</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          <StatRow label="cache size" value={String(prefs.sessionCacheSize)} />
          <StatRow label="timeout" value={prefs.sessionCacheTimeout > 0 ? `${prefs.sessionCacheTimeout}m` : 'never'} />
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Memory</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          <StatRow label="cached sessions" value={String(cachedIds.length)} accent />
          <StatRow label="transcript entries" value={String(totalEntries)} />
          <StatRow label="hook events" value={String(totalEvents)} />
          <StatRow label="est. memory" value={formatMemory(totalEntries + totalEvents)} />
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Cached Sessions (MRU order)</div>
        <div className="max-h-48 overflow-y-auto space-y-1">
          {mru
            .filter(id => cachedIds.includes(id))
            .map(id => {
              const session = sessions.find(s => s.id === id)
              const name = session?.title || session?.cwd.split('/').pop() || id.slice(0, 8)
              const entryCount = transcripts[id]?.length ?? 0
              const isSelected = id === selected
              return (
                <div
                  key={id}
                  className={cn('flex items-center gap-2 py-1 px-2 rounded text-[11px]', isSelected && 'bg-accent/10')}
                >
                  {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                  <span className={cn('truncate flex-1', isSelected ? 'text-accent' : 'text-[#a9b1d6]')}>{name}</span>
                  <span className="text-[#565f89] tabular-nums shrink-0">{entryCount} entries</span>
                </div>
              )
            })}
          {cachedIds.length === 0 && <div className="text-[11px] text-[#565f89]">No sessions cached</div>}
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">WS Subscriptions</div>
        <div className="max-h-32 overflow-y-auto space-y-0.5">
          {cachedIds.map(id => {
            const session = sessions.find(s => s.id === id)
            const name = session?.title || session?.cwd.split('/').pop() || id.slice(0, 8)
            return (
              <div key={id} className="text-[10px] text-[#a9b1d6] font-mono">
                <span className="text-[#9ece6a]">SUB</span> {name}
                <span className="text-[#565f89]"> (events, transcript, tasks, bg_output)</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-yellow-400',
  debug: 'text-cyan-400/70',
  log: 'text-foreground/80',
}

function LogTab() {
  const [entries, setEntries] = useState(getLogEntries)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return subscribeLog(() => {
      setEntries([...getLogEntries()])
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      })
    })
  }, [])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            copyLogText()
          }}
          className="text-[10px] text-[#7aa2f7] hover:text-[#89b4fa] px-2 py-0.5 border border-[#33467c]/50 rounded"
        >
          Copy
        </button>
        <button
          type="button"
          onClick={() => {
            clearLog()
            setEntries([])
          }}
          className="text-[10px] text-red-400 hover:text-red-300 px-2 py-0.5 border border-[#33467c]/50 rounded"
        >
          Clear
        </button>
        <span className="text-[10px] text-[#565f89] ml-auto">{entries.length} entries</span>
      </div>
      <div ref={scrollRef} className="max-h-64 overflow-y-auto bg-black/30 rounded p-2 space-y-0.5">
        {entries.length === 0 ? (
          <div className="text-[11px] text-[#565f89]">No log entries</div>
        ) : (
          entries.map((entry, i) => {
            const ts = new Date(entry.t).toISOString().slice(11, 23)
            return (
              <div
                key={i}
                className={`flex gap-2 font-mono text-[10px] leading-relaxed ${LEVEL_COLORS[entry.level] || 'text-foreground'}`}
              >
                <span className="text-muted-foreground/40 shrink-0 select-none">{ts}</span>
                <span className="whitespace-pre-wrap break-all">{entry.args}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export function NerdModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('cache')
  const [serverStats, setServerStats] = useState<ServerStats | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/stats', { credentials: 'same-origin' })
      if (!res.ok) {
        setFetchError(`HTTP ${res.status}`)
        return
      }
      setServerStats(await res.json())
      setFetchError(null)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'fetch failed')
    }
  }, [])

  useEffect(() => {
    if (!open) return
    fetchStats()
    const id = setInterval(fetchStats, 1000)
    return () => clearInterval(id)
  }, [open, fetchStats])

  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  const tabs: { id: Tab; label: string }[] = [
    { id: 'cache', label: 'Cache' },
    { id: 'traffic', label: 'Traffic' },
    { id: 'log', label: 'Log' },
  ]

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape handled via window listener
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal panel */}
      <div
        className="w-full max-w-lg max-h-[80vh] overflow-hidden bg-[#16161e] border border-[#33467c] shadow-2xl font-mono flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 pb-0">
          <pre className="text-[#7aa2f7] text-[10px] leading-tight mb-3 select-none text-center">
            {`┌─────────────────────────────────┐
│      DETAILS FOR NERDS          │
└─────────────────────────────────┘`}
          </pre>

          <div className="flex gap-1 mb-3">
            {tabs.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  'px-3 py-1 text-[10px] uppercase tracking-wider transition-colors',
                  tab === t.id
                    ? 'bg-[#7aa2f7]/20 text-[#7aa2f7] border border-[#7aa2f7]/40'
                    : 'text-[#565f89] border border-transparent hover:text-[#a9b1d6]',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {tab === 'traffic' && <TrafficTab serverStats={serverStats} fetchError={fetchError} />}
          {tab === 'cache' && <CacheTab />}
          {tab === 'log' && <LogTab />}
        </div>

        <div className="text-center text-[10px] text-[#565f89] py-2 border-t border-[#33467c]/30">
          <kbd className="px-1 py-0.5 bg-[#33467c]/30 text-[#7aa2f7]">Esc</kbd> to close
        </div>
      </div>
    </div>
  )
}
