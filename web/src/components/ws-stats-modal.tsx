/**
 * WS Stats Modal - detailed server-side metrics overlay
 * Polls /api/stats every 3s while open, shows both client and server traffic
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { getRates, subscribe as subscribeStats } from '@/hooks/ws-stats'

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

interface WsStatsModalProps {
  open: boolean
  onClose: () => void
}

export function WsStatsModal({ open, onClose }: WsStatsModalProps) {
  const [serverStats, setServerStats] = useState<ServerStats | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const clientRates = useSyncExternalStore(subscribeStats, getRates)

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/stats', { credentials: 'same-origin' })
      if (!res.ok) {
        setFetchError(`HTTP ${res.status}`)
        return
      }
      const data = await res.json()
      setServerStats(data)
      setFetchError(null)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'fetch failed')
    }
  }, [])

  // Poll server stats every 3s while open
  useEffect(() => {
    if (!open) return
    fetchStats()
    const id = setInterval(fetchStats, 3000)
    return () => clearInterval(id)
  }, [open, fetchStats])

  // Escape to close
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  const channelEntries = serverStats ? Object.entries(serverStats.channels) : []

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape handled via window keydown listener
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop dismiss
    <div className="fixed inset-0 z-[70] flex items-center justify-center" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal panel */}
      <div
        className="w-full max-w-lg bg-[#16161e] border border-[#33467c] shadow-2xl font-mono p-5"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <pre className="text-[#7aa2f7] text-[10px] leading-tight mb-4 select-none text-center">
          {`┌─────────────────────────────────┐
│  WS TRAFFIC / SERVER METRICS    │
└─────────────────────────────────┘`}
        </pre>

        {/* Client-side rates */}
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Client (browser WS)</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <StatRow label="msg in" value={`${clientRates.msgInPerSec.toFixed(1)}/s`} />
            <StatRow label="msg out" value={`${clientRates.msgOutPerSec.toFixed(1)}/s`} />
            <StatRow label="bytes in" value={formatBytes(clientRates.bytesInPerSec)} />
            <StatRow label="bytes out" value={formatBytes(clientRates.bytesOutPerSec)} />
          </div>
        </div>

        {/* Server stats */}
        {fetchError && <div className="text-[11px] text-red-400 mb-3">Server fetch error: {fetchError}</div>}

        {serverStats && (
          <>
            {/* Uptime */}
            <div className="mb-4">
              <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Server</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <StatRow label="uptime" value={formatUptime(serverStats.uptime)} />
              </div>
            </div>

            {/* Sessions */}
            <div className="mb-4">
              <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Sessions</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <StatRow label="total" value={String(serverStats.sessions.total)} />
                <StatRow label="active" value={String(serverStats.sessions.active)} accent />
                <StatRow label="idle" value={String(serverStats.sessions.idle)} />
                <StatRow label="ended" value={String(serverStats.sessions.ended)} dim />
              </div>
            </div>

            {/* Connections */}
            <div className="mb-4">
              <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Connections</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <StatRow label="total" value={String(serverStats.connections.total)} />
                <StatRow label="v2 (pub/sub)" value={String(serverStats.connections.v2)} accent />
                <StatRow label="legacy (v1)" value={String(serverStats.connections.legacy)} dim />
              </div>
            </div>

            {/* Server traffic */}
            <div className="mb-4">
              <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Server Traffic</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <StatRow label="msg in" value={`${serverStats.traffic.in.messagesPerSec}/s`} />
                <StatRow label="msg out" value={`${serverStats.traffic.out.messagesPerSec}/s`} />
                <StatRow label="bytes in" value={formatBytes(serverStats.traffic.in.bytesPerSec)} />
                <StatRow label="bytes out" value={formatBytes(serverStats.traffic.out.bytesPerSec)} />
              </div>
            </div>

            {/* Channels */}
            {channelEntries.length > 0 && (
              <div className="mb-4">
                <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">
                  Channels ({channelEntries.length})
                </div>
                <div className="max-h-32 overflow-y-auto">
                  {channelEntries.map(([name, count]) => (
                    <div key={name} className="flex justify-between py-0.5 border-b border-[#33467c]/20 text-[11px]">
                      <span className="text-[#a9b1d6] truncate mr-2">{name}</span>
                      <span className="text-[#7aa2f7] tabular-nums">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {!serverStats && !fetchError && <div className="text-[11px] text-[#565f89] mb-3">Loading server stats...</div>}

        {/* SW Cache */}
        <SwCacheSection />

        <div className="text-center text-[10px] text-[#565f89]">
          Press <kbd className="px-1 py-0.5 bg-[#33467c]/30 text-[#7aa2f7]">Esc</kbd> or click outside to close
        </div>
      </div>
    </div>
  )
}

function SwCacheSection() {
  const [swStatus, setSwStatus] = useState('...')
  const [cacheInfo, setCacheInfo] = useState<Array<{ name: string; count: number; sizeKB: number }>>([])
  const [totalKB, setTotalKB] = useState(0)

  useEffect(() => {
    async function load() {
      if (!('serviceWorker' in navigator)) {
        setSwStatus('unsupported')
        return
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js')
        setSwStatus(reg?.active ? 'active' : reg?.waiting ? 'waiting' : reg ? 'installing' : 'not registered')
      } catch {
        setSwStatus('error')
      }
      try {
        const keys = await caches.keys()
        let total = 0
        const infos: typeof cacheInfo = []
        for (const name of keys) {
          const cache = await caches.open(name)
          const entries = await cache.keys()
          let sizeKB = 0
          for (const req of entries) {
            try {
              const res = await cache.match(req)
              if (res) {
                const blob = await res.clone().blob()
                sizeKB += blob.size / 1024
              }
            } catch {}
          }
          sizeKB = Math.round(sizeKB)
          total += sizeKB
          infos.push({ name, count: entries.length, sizeKB })
        }
        setCacheInfo(infos)
        setTotalKB(Math.round(total))
      } catch {}
    }
    load()
  }, [])

  return (
    <div className="mb-4">
      <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Service Worker Cache</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <StatRow
          label="status"
          value={swStatus}
          accent={swStatus === 'active'}
          dim={swStatus === 'not registered' || swStatus === 'unsupported'}
        />
        <StatRow label="total size" value={totalKB > 1024 ? `${(totalKB / 1024).toFixed(1)} MB` : `${totalKB} KB`} />
      </div>
      {cacheInfo.length > 0 && (
        <div className="mt-2 max-h-24 overflow-y-auto">
          {cacheInfo.map(c => (
            <div key={c.name} className="flex justify-between py-0.5 border-b border-[#33467c]/20 text-[10px]">
              <span className="text-[#a9b1d6] truncate mr-2">{c.name}</span>
              <span className="text-[#565f89] mr-2">{c.count} entries</span>
              <span className="text-[#7aa2f7] tabular-nums">
                {c.sizeKB > 1024 ? `${(c.sizeKB / 1024).toFixed(1)} MB` : `${c.sizeKB} KB`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
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
