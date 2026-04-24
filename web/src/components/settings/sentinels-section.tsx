import { useCallback, useEffect, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { haptic } from '@/lib/utils'

interface SentinelEntry {
  sentinelId: string
  alias: string
  aliases: string[]
  isDefault: boolean
  color?: string
  connected: boolean
  hostname?: string
  spawnRoot?: string
  createdAt: number
}

export function SentinelsSection() {
  const [sentinels, setSentinels] = useState<SentinelEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newAlias, setNewAlias] = useState('')
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const connectedSentinels = useSessionsStore(s => s.sentinels)

  const fetchSentinels = useCallback(() => {
    setLoading(true)
    fetch('/api/sentinels')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setSentinels(data)
        else setError(data.error || 'Failed to load sentinels')
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    fetchSentinels()
  }, [fetchSentinels, connectedSentinels])

  function handleCreate() {
    if (!newAlias.trim()) return
    setCreating(true)
    setCreatedSecret(null)
    fetch('/api/sentinels/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: newAlias.trim().toLowerCase() }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.sentinelSecret) {
          setCreatedSecret(data.sentinelSecret)
          setNewAlias('')
          fetchSentinels()
          haptic('success')
        } else {
          setError(data.error || 'Failed to create sentinel')
          haptic('error')
        }
        setCreating(false)
      })
      .catch(err => {
        setError(err.message)
        setCreating(false)
        haptic('error')
      })
  }

  function handleSetDefault(sentinelId: string) {
    fetch(`/api/sentinels/${sentinelId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    })
      .then(() => {
        fetchSentinels()
        haptic('tap')
      })
      .catch(() => haptic('error'))
  }

  function handleRevoke(sentinelId: string, alias: string) {
    if (!confirm(`Revoke sentinel "${alias}"? This invalidates its secret.`)) return
    fetch(`/api/sentinels/${sentinelId}`, { method: 'DELETE' })
      .then(() => {
        fetchSentinels()
        haptic('tap')
      })
      .catch(() => haptic('error'))
  }

  if (loading && sentinels.length === 0) {
    return <div className="text-xs text-muted-foreground">Loading sentinels...</div>
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-xs text-destructive">{error}</div>}

      {/* Sentinel list */}
      <div className="space-y-2">
        {sentinels.map(s => (
          <div
            key={s.sentinelId}
            className="flex items-center gap-2 p-2 border border-border rounded text-xs font-mono"
          >
            <span className={`text-sm ${s.connected ? 'text-active' : 'text-muted-foreground/40'}`}>
              {s.connected ? '●' : '○'}
            </span>
            <span className="font-bold text-foreground">{s.alias}</span>
            {s.hostname && <span className="text-muted-foreground/50">{s.hostname}</span>}
            {s.isDefault && (
              <span className="px-1 py-0.5 text-[8px] bg-accent/20 text-accent rounded uppercase font-bold">
                default
              </span>
            )}
            <span className="flex-1" />
            {!s.isDefault && (
              <button
                type="button"
                className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
                onClick={() => handleSetDefault(s.sentinelId)}
              >
                set default
              </button>
            )}
            <button
              type="button"
              className="text-[10px] text-destructive/70 hover:text-destructive cursor-pointer"
              onClick={() => handleRevoke(s.sentinelId, s.alias)}
            >
              revoke
            </button>
          </div>
        ))}
        {sentinels.length === 0 && (
          <div className="text-xs text-muted-foreground/50">No sentinels registered. Create one below.</div>
        )}
      </div>

      {/* Create new sentinel */}
      <div className="border-t border-border/50 pt-3">
        <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-2">Create Sentinel</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newAlias}
            onChange={e => setNewAlias(e.target.value)}
            placeholder="alias (e.g. beast)"
            className="flex-1 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-ring"
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate()
            }}
          />
          <button
            type="button"
            disabled={creating || !newAlias.trim()}
            className="px-3 py-1 text-xs font-mono bg-accent text-accent-foreground hover:bg-accent/80 disabled:opacity-50 cursor-pointer"
            onClick={handleCreate}
          >
            {creating ? '...' : 'create'}
          </button>
        </div>
      </div>

      {/* Show created secret */}
      {createdSecret && (
        <div className="p-3 border border-active/50 bg-active/5 rounded space-y-2">
          <div className="text-[10px] text-active uppercase tracking-wider font-bold">Secret (shown once)</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[10px] font-mono text-foreground break-all select-all">{createdSecret}</code>
            <button
              type="button"
              className="px-2 py-1 text-[10px] font-mono border border-border hover:bg-muted cursor-pointer shrink-0"
              onClick={() => {
                navigator.clipboard.writeText(createdSecret)
                haptic('tick')
              }}
            >
              copy
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Configure the sentinel:
            <pre className="mt-1 p-2 bg-muted rounded text-[9px] whitespace-pre-wrap">
              {`export CLAUDWERK_SENTINEL_SECRET=${createdSecret}\nexport CLAUDWERK_BROKER=wss://<your-broker-host>\nsentinel --alias <alias>`}
            </pre>
          </div>
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => setCreatedSecret(null)}
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  )
}
