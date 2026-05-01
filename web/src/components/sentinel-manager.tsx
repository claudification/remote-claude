import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useConversationsStore } from '@/hooks/use-sessions'
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

function SentinelRow({
  sentinel,
  onSetDefault,
  onRevoke,
}: {
  sentinel: SentinelEntry
  onSetDefault: () => void
  onRevoke: () => void
}) {
  return (
    <div className="flex items-center gap-2 p-2 border border-border rounded text-xs font-mono">
      <span className={`text-sm ${sentinel.connected ? 'text-active' : 'text-muted-foreground/40'}`}>
        {sentinel.connected ? '●' : '○'}
      </span>
      <span className="font-bold text-foreground">{sentinel.alias}</span>
      {sentinel.hostname && <span className="text-muted-foreground/50">{sentinel.hostname}</span>}
      {sentinel.isDefault && (
        <span className="px-1 py-0.5 text-[8px] bg-accent/20 text-accent rounded uppercase font-bold">default</span>
      )}
      <span className="flex-1" />
      {!sentinel.isDefault && (
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
          onClick={onSetDefault}
        >
          set default
        </button>
      )}
      <button
        type="button"
        className="text-[10px] text-destructive/70 hover:text-destructive cursor-pointer"
        onClick={onRevoke}
      >
        revoke
      </button>
    </div>
  )
}

function CreatedSecretBanner({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  return (
    <div className="p-3 border border-active/50 bg-active/5 rounded space-y-2">
      <div className="text-[10px] text-active uppercase tracking-wider font-bold">Secret (shown once)</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-[10px] font-mono text-foreground break-all select-all">{secret}</code>
        <button
          type="button"
          className="px-2 py-1 text-[10px] font-mono border border-border hover:bg-muted cursor-pointer shrink-0"
          onClick={() => {
            navigator.clipboard.writeText(secret)
            haptic('tick')
          }}
        >
          copy
        </button>
      </div>
      <div className="text-[10px] text-muted-foreground mt-1">
        Configure the sentinel:
        <pre className="mt-1 p-2 bg-muted rounded text-[9px] whitespace-pre-wrap">
          {`export CLAUDWERK_SENTINEL_SECRET=${secret}\nexport CLAUDWERK_BROKER=wss://<your-broker-host>\nsentinel --alias <alias>`}
        </pre>
      </div>
      <button
        type="button"
        className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
        onClick={onDismiss}
      >
        dismiss
      </button>
    </div>
  )
}

function SentinelList() {
  const [sentinels, setSentinels] = useState<SentinelEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newAlias, setNewAlias] = useState('')
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const connectedSentinels = useConversationsStore(s => s.sentinels)

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: connectedSentinels is a refetch trigger
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
    return <div className="text-xs text-muted-foreground text-center py-4">Loading sentinels...</div>
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-xs text-destructive">{error}</div>}

      <div className="space-y-2">
        {sentinels.map(s => (
          <SentinelRow
            key={s.sentinelId}
            sentinel={s}
            onSetDefault={() => handleSetDefault(s.sentinelId)}
            onRevoke={() => handleRevoke(s.sentinelId, s.alias)}
          />
        ))}
        {sentinels.length === 0 && (
          <div className="text-xs text-muted-foreground/50 text-center py-2">
            No sentinels registered. Create one below.
          </div>
        )}
      </div>

      <div className="border-t border-border/50 pt-3">
        <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-2">Create Sentinel</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newAlias}
            onChange={e => setNewAlias(e.target.value)}
            placeholder="alias (e.g. beast)"
            className="flex-1 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-ring rounded"
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate()
            }}
          />
          <button
            type="button"
            disabled={creating || !newAlias.trim()}
            className="px-3 py-1 text-xs font-mono bg-accent text-accent-foreground hover:bg-accent/80 disabled:opacity-50 cursor-pointer rounded"
            onClick={handleCreate}
          >
            {creating ? '...' : 'create'}
          </button>
        </div>
      </div>

      {createdSecret && <CreatedSecretBanner secret={createdSecret} onDismiss={() => setCreatedSecret(null)} />}
    </div>
  )
}

export function SentinelManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] p-0">
        <div className="px-6 pt-5 pb-3 pr-12">
          <DialogTitle className="text-accent font-bold uppercase tracking-wider text-[10px]">Sentinels</DialogTitle>
        </div>
        <div className="px-6 pb-6 overflow-y-auto">
          <SentinelList />
        </div>
      </DialogContent>
    </Dialog>
  )
}
