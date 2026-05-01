/**
 * SharePanel - Session sharing management.
 *
 * Shows active shares with viewer counts, create new shares,
 * revoke shares. Displayed as a banner in the session detail header.
 *
 * Share data is pushed via WS (shares_updated) - no polling.
 */

import { Copy, Eye, Link2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useConversationsStore } from '@/hooks/use-sessions'
import { haptic } from '@/lib/utils'

interface SharePanelProps {
  sessionProject: string
}

const DURATION_OPTIONS = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '4h', ms: 4 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
]

const EMPTY_SHARES: ReturnType<typeof useConversationsStore.getState>['shares'] = []

export function ShareBanner({ sessionProject }: SharePanelProps) {
  const allShares = useConversationsStore(s => s.shares) || EMPTY_SHARES
  const shares = allShares.filter(s => s.sessionCwd === sessionProject && s.expiresAt > Date.now())

  const [expanded, setExpanded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newDuration, setNewDuration] = useState(DURATION_OPTIONS[1].ms)
  const [newPerms, setNewPerms] = useState<Record<string, boolean>>({
    chat: false,
    'files:read': false,
    'terminal:read': true,
  })
  const [hideUserInput, setHideUserInput] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)

  async function handleCreate() {
    setCreating(true)
    try {
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionCwd: sessionProject,
          expiresIn: newDuration,
          label: newLabel || undefined,
          permissions: [
            'chat:read', // always included (base - can see transcript)
            ...Object.entries(newPerms)
              .filter(([, v]) => v)
              .map(([k]) => k),
          ],
          hideUserInput,
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
      } else {
        console.error('Share create failed:', res.status, await res.text().catch(() => ''))
        haptic('error')
      }
    } catch (err) {
      console.error('Share create error:', err)
      haptic('error')
    }
    setCreating(false)
  }

  async function handleRevoke(token: string) {
    haptic('error')
    try {
      await fetch(`/api/shares/${token}`, { method: 'DELETE' })
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

  // No shares and not expanded: show a subtle "Share" button as entry point
  if (shares.length === 0 && !expanded) {
    return (
      <div className="shrink-0 border-b border-border/50">
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            setExpanded(true)
          }}
          className="w-full px-3 py-1.5 flex items-center gap-2 text-[10px] font-mono text-muted-foreground hover:text-teal-400 hover:bg-teal-500/5 transition-colors"
        >
          <Link2 className="w-3 h-3" />
          <span className="uppercase tracking-wider">Share this session</span>
        </button>
      </div>
    )
  }

  return (
    <div className="shrink-0 border-b border-teal-500/30 bg-teal-500/5">
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
        <span className="text-teal-400 font-bold uppercase tracking-wider">Shared ({shares.length})</span>
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
          {shares.map(share => {
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
                    {share.hideUserInput && (
                      <span className="text-amber-400/70 font-bold" title="User input hidden">
                        no user
                      </span>
                    )}
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
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center gap-2">
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
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Permissions:</span>
              {[
                { key: 'chat', label: 'Can chat', desc: 'Send messages' },
                { key: 'files:read', label: 'See files', desc: 'View files' },
                { key: 'terminal:read', label: 'Watch terminal', desc: 'Read-only terminal' },
              ].map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setNewPerms(prev => ({ ...prev, [opt.key]: !prev[opt.key] }))}
                  title={opt.desc}
                  className={`px-1.5 py-0.5 rounded text-[9px] transition-colors ${
                    newPerms[opt.key]
                      ? 'bg-teal-500/25 text-teal-400 border border-teal-500/40'
                      : 'bg-secondary text-muted-foreground/50 border border-transparent hover:border-border'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              {!newPerms.chat && !newPerms['files:read'] && !newPerms['terminal:read'] && (
                <span className="text-[9px] text-muted-foreground/50 italic">read-only (transcript only)</span>
              )}
              <span className="w-px h-3 bg-border/50 mx-0.5" />
              <button
                type="button"
                onClick={() => setHideUserInput(v => !v)}
                title="Hide all user messages from shared view"
                className={`px-1.5 py-0.5 rounded text-[9px] transition-colors ${
                  hideUserInput
                    ? 'bg-amber-500/25 text-amber-400 border border-amber-500/40'
                    : 'bg-secondary text-muted-foreground/50 border border-transparent hover:border-border'
                }`}
              >
                Hide user input
              </button>
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={handleCreate}
                disabled={creating}
                className="text-[10px] h-6 px-2 border-teal-500/30 text-teal-400 hover:bg-teal-500/10"
              >
                <Link2 className="w-3 h-3 mr-1" />
                {creating ? '...' : 'Create share link'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Small share indicator for the session list sidebar */
export function ShareIndicator({ sessionProject }: { sessionProject: string }) {
  const count = useConversationsStore(
    s => s.shares.filter(sh => sh.sessionCwd === sessionProject && sh.expiresAt > Date.now()).length,
  )

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
