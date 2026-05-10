import { Fzf } from 'fzf'
import { useMemo, useState } from 'react'
import { cn, haptic } from '@/lib/utils'

const API_BASE = `${window.location.protocol}//${window.location.host}/api`

interface ModelPickerProps {
  value: string
  onChange: (model: string) => void
  url: string
  apiKey: string
}

export function ModelPicker({ value, onChange, url, apiKey }: ModelPickerProps) {
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showList, setShowList] = useState(false)

  async function handleFetch() {
    if (!url || !apiKey) return setError('URL and API key required first')
    haptic('tap')
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/chat/connections/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, apiKey }),
      })
      const data = (await res.json()) as { ok: boolean; models?: string[]; error?: string }
      if (!data.ok || !data.models) return setError(data.error || 'Failed to fetch models')
      setModels(data.models)
      setShowList(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-muted-foreground w-12 shrink-0 text-right">Model</span>
        <input
          type="text"
          value={value}
          onChange={e => {
            onChange(e.target.value)
            if (models.length > 0) setShowList(true)
          }}
          onFocus={() => {
            if (models.length > 0) setShowList(true)
          }}
          placeholder="(optional)"
          className="flex-1 bg-surface-inset border border-border rounded px-2 py-1 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        <button
          type="button"
          onClick={handleFetch}
          disabled={loading || !url || !apiKey}
          className="text-[10px] font-mono px-2 py-1 rounded bg-surface-inset hover:bg-muted/50 transition-colors disabled:opacity-40 shrink-0"
        >
          {loading ? '...' : models.length > 0 ? 'reload' : 'fetch'}
        </button>
      </div>

      {error && <div className="text-[10px] text-red-400 font-mono pl-14">{error}</div>}

      {showList && models.length > 0 && (
        <ModelList
          models={models}
          filter={value}
          selected={value}
          onSelect={model => {
            onChange(model)
            setShowList(false)
            haptic('tick')
          }}
        />
      )}
    </div>
  )
}

function ModelList({
  models,
  filter,
  selected,
  onSelect,
}: {
  models: string[]
  filter: string
  selected: string
  onSelect: (model: string) => void
}) {
  const fzf = useMemo(() => new Fzf(models, { limit: 50 }), [models])
  const filtered = filter ? fzf.find(filter).map(r => r.item) : models.slice(0, 50)

  return (
    <div className="ml-14 max-h-[160px] overflow-y-auto rounded border border-border bg-surface-inset">
      {filtered.length === 0 ? (
        <div className="text-[10px] text-muted-foreground font-mono px-2 py-1">No matches</div>
      ) : (
        filtered.map(model => (
          <button
            key={model}
            type="button"
            onClick={() => onSelect(model)}
            className={cn(
              'w-full text-left text-[10px] font-mono px-2 py-0.5 hover:bg-primary/10 transition-colors truncate',
              model === selected && 'text-primary bg-primary/5',
            )}
          >
            {model}
          </button>
        ))
      )}
    </div>
  )
}
