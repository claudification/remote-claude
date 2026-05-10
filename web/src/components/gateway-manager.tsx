import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { haptic } from '@/lib/utils'

interface GatewayEntry {
  gatewayId: string
  alias: string
  gatewayType: string
  label?: string
  connected: boolean
  createdAt: number
}

function GatewayRow({ gateway, onRevoke }: { gateway: GatewayEntry; onRevoke: () => void }) {
  return (
    <div className="flex items-center gap-2 p-2 border border-border rounded text-xs font-mono">
      <span className={`text-sm ${gateway.connected ? 'text-active' : 'text-muted-foreground/40'}`}>
        {gateway.connected ? '●' : '○'}
      </span>
      <span className="font-bold text-foreground">{gateway.alias}</span>
      <span className="text-muted-foreground/50">{gateway.gatewayType}</span>
      {gateway.label && <span className="text-muted-foreground/40">{gateway.label}</span>}
      <span className="flex-1" />
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
        Configure the gateway adapter:
        <pre className="mt-1 p-2 bg-muted rounded text-[9px] whitespace-pre-wrap">
          {`export CLAUDWERK_ADAPTER_SECRET=${secret}\nexport CLAUDWERK_BROKER_URL=wss://<your-broker-host>/ws`}
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

function GatewayList() {
  const [gateways, setGateways] = useState<GatewayEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newAlias, setNewAlias] = useState('')
  const [newType, setNewType] = useState('hermes')
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)

  const fetchGateways = useCallback(() => {
    setLoading(true)
    fetch('/api/gateways')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setGateways(data)
        else setError(data.error || 'Failed to load gateways')
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    fetchGateways()
  }, [fetchGateways])

  function handleCreate() {
    if (!newAlias.trim()) return
    setCreating(true)
    setCreatedSecret(null)
    fetch('/api/gateways/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alias: newAlias.trim().toLowerCase(),
        gatewayType: newType.trim() || 'hermes',
      }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.gatewaySecret) {
          setCreatedSecret(data.gatewaySecret)
          setNewAlias('')
          fetchGateways()
          haptic('success')
        } else {
          setError(data.error || 'Failed to create gateway')
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

  function handleRevoke(gatewayId: string, alias: string) {
    if (!confirm(`Revoke gateway "${alias}"? This invalidates its secret.`)) return
    fetch(`/api/gateways/${gatewayId}`, { method: 'DELETE' })
      .then(() => {
        fetchGateways()
        haptic('tap')
      })
      .catch(() => haptic('error'))
  }

  if (loading && gateways.length === 0) {
    return <div className="text-xs text-muted-foreground text-center py-4">Loading gateways...</div>
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-xs text-destructive">{error}</div>}

      <div className="space-y-2">
        {gateways.map(g => (
          <GatewayRow key={g.gatewayId} gateway={g} onRevoke={() => handleRevoke(g.gatewayId, g.alias)} />
        ))}
        {gateways.length === 0 && (
          <div className="text-xs text-muted-foreground/50 text-center py-2">
            No gateways registered. Create one below.
          </div>
        )}
      </div>

      <div className="border-t border-border/50 pt-3">
        <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-2">Create Gateway</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newAlias}
            onChange={e => setNewAlias(e.target.value)}
            placeholder="alias (e.g. hermes-prod)"
            className="flex-1 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-ring rounded"
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate()
            }}
          />
          <input
            type="text"
            value={newType}
            onChange={e => setNewType(e.target.value)}
            placeholder="type"
            className="w-20 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-ring rounded"
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

export function GatewayManagerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] p-0">
        <div className="px-6 pt-5 pb-3 pr-12">
          <DialogTitle className="text-accent font-bold uppercase tracking-wider text-[10px]">Gateways</DialogTitle>
        </div>
        <div className="px-6 pb-6 overflow-y-auto">
          <GatewayList />
        </div>
      </DialogContent>
    </Dialog>
  )
}
