/**
 * SharePanel - Session sharing management.
 *
 * Shows active shares with viewer counts, create new shares,
 * revoke shares. Displayed as a banner in the session detail header.
 */

import { Copy, Eye, Link2, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { appendShareParam } from '@/lib/share-mode'
import { haptic } from '@/lib/utils'

interface Share {
  token: string
  sessionCwd: string
  createdAt: number
  expiresAt: number
  createdBy: string
  label?: string
  revoked: boolean
  permissions: string[]
  viewerCount: number
}

interface SharePanelProps {
  sessionCwd: string
}

const DURATION_OPTIONS = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '4h', ms: 4 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
]

export function ShareBanner({ sessionCwd }: SharePanelProps) {
  const [shares, setShares] = useState<Share[]>([])
  const [expanded, setExpanded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newDuration, setNewDuration] = useState(DURATION_OPTIONS[1].ms)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)

  const fetchShares = useCallback(async () => {
    try {
      const res = await fetch('/api/shares')
      if (!res.ok) return
      const data = await res.json()
      // Filter to shares for this session's CWD
      setShares((data.shares || []).filter((s: Share) => s.sessionCwd === sessionCwd && !s.revoked))
    } catch {}
  }, [sessionCwd])

  useEffect(() => {
    fetchShares()
    // Poll for viewer count updates
    const timer = setInterval(fetchShares, 15_000)
    return () => clearInterval(timer)
  }, [fetchShares])

  async function handleCreate() {
    setCreating(true)
    try {
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionCwd,
          expiresIn: newDuration,
          label: newLabel || undefined,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const shareUrl = `${window.location.origin}/#/share/${data.token}`
        await navigator.clipboard.writeText(shareUrl)
        setCopyFeedback(data.token)
        setTimeout(() => setCopyFeedback(null), 3000)
        haptic('success')
        setNewLabel('')
        fetchShares()
      }
    } catch {}
    setCreating(false)
  }

  async function handleRevoke(token: string) {
    haptic('error')
    try {
      await fetch(`/api/shares/${token}`, { method: 'DELETE' })
      fetchShares()
    } catch {}
  }

  function handleCopyLink(token: string) {
    const url = `${window.location.origin}/#/share/${token}`
    navigator.clipboard.writeText(url)
    setCopyFeedback(token)
    setTimeout(() => setCopyFeedback(null), 2000)
    haptic('tap')
  }

  const totalViewers = shares.reduce((sum, s) => sum + s.viewerCount, 0)
  const activeShares = shares.filter(s => s.expiresAt > Date.now())

  if (activeShares.length === 0 && !expanded) return null

  return (
    <div className="border-b border-teal-500/30 bg-teal-500/5">
      {/* Collapsed: just the indicator bar */}
      <button
        type="button"
        onClick={() => {
          haptic('tap')
          setExpanded(!expanded)
        }}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-[10px] font-mono hover:bg-teal-500/10 transition-colors"
      >
        <Link2 className="w-3 h-3 text-teal-400" />
        <span className="text-teal-400 font-bold uppercase tracking-wider">Shared ({activeShares.length})</span>
        {totalViewers > 0 && (
          <span className="flex items-center gap-1 text-teal-400/70">
            <Eye className="w-3 h-3" />
            {totalViewers} viewing
          </span>
        )}
        <span className="flex-1" />
        <span className="text-muted-foreground">{expanded ? '\u25B2' : '\u25BC'}</span>
      </button>

      {/* Expanded: share list + create */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Active shares */}
          {activeShares.map(share => {
            const timeLeft = share.expiresAt - Date.now()
            const hours = Math.floor(timeLeft / 3600000)
            const mins = Math.floor((timeLeft % 3600000) / 60000)
            const timeStr =
              hours > 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`

            return (
              <div key={share.token} className="flex items-center gap-2 bg-teal-500/10 rounded px-2 py-1.5 text-[10px]">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-teal-400 font-bold truncate">{share.label || share.token.slice(0, 8)}</span>
                    <span className="text-muted-foreground">expires {timeStr}</span>
                    {share.viewerCount > 0 && (
                      <span className="flex items-center gap-0.5 text-teal-400/70">
                        <Eye className="w-2.5 h-2.5" /> {share.viewerCount}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopyLink(share.token)}
                  className="text-muted-foreground hover:text-teal-400 p-1"
                  title="Copy link"
                >
                  {copyFeedback === share.token ? (
                    <span className="text-green-400 text-[9px]">Copied!</span>
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handleRevoke(share.token)}
                  className="text-muted-foreground hover:text-destructive p-1"
                  title="Stop sharing"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )
          })}

          {/* Create new share */}
          <div className="flex items-center gap-2 pt-1">
            <input
              type="text"
              placeholder="Label (optional)"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              className="flex-1 bg-background border border-border rounded px-2 py-1 text-[10px] font-mono focus:outline-none focus:border-teal-400 min-w-0"
            />
            <div className="flex gap-0.5">
              {DURATION_OPTIONS.map(opt => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setNewDuration(opt.ms)}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
                    newDuration === opt.ms
                      ? 'bg-teal-500/30 text-teal-400 border border-teal-500/50'
                      : 'bg-secondary text-muted-foreground border border-transparent hover:border-border'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCreate}
              disabled={creating}
              className="text-[10px] h-6 px-2 border-teal-500/30 text-teal-400 hover:bg-teal-500/10"
            >
              <Link2 className="w-3 h-3 mr-1" />
              {creating ? '...' : 'Share'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Small share indicator for the session list sidebar */
export function ShareIndicator({ sessionCwd }: { sessionCwd: string }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let mounted = true
    async function check() {
      try {
        const res = await fetch('/api/shares')
        if (!res.ok || !mounted) return
        const data = await res.json()
        const active = (data.shares || []).filter(
          (s: Share) => s.sessionCwd === sessionCwd && !s.revoked && s.expiresAt > Date.now(),
        )
        if (mounted) setCount(active.length)
      } catch {}
    }
    check()
    const timer = setInterval(check, 30_000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [sessionCwd])

  if (count === 0) return null

  return (
    <span
      className="px-1 py-0.5 text-[8px] font-bold bg-teal-500/20 text-teal-400 rounded"
      title={`${count} active share${count > 1 ? 's' : ''}`}
    >
      <Link2 className="w-2 h-2 inline" />
    </span>
  )
}
