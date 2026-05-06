import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { haptic } from '@/lib/utils'

interface IndexStats {
  totalEntries: number
  indexedDocs: number
  conversations: number
  isComplete: boolean
}

interface RebuildResult {
  docsIndexed: number
  durationMs: number
}

function fmtNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function StatRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-border/30 last:border-b-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 w-32 shrink-0">{label}</span>
      <span className="text-sm font-mono font-bold text-foreground">{value}</span>
      {hint && <span className="text-[10px] text-muted-foreground/50 ml-auto">{hint}</span>}
    </div>
  )
}

function SearchIndexManager() {
  const [stats, setStats] = useState<IndexStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [lastRebuild, setLastRebuild] = useState<RebuildResult | null>(null)
  const [confirmRebuild, setConfirmRebuild] = useState(false)

  const fetchStats = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/search-index/stats')
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${body ? ` - ${body.slice(0, 120)}` : ''}`)
      }
      const data = (await res.json()) as IndexStats
      setStats(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load index stats')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  async function handleRebuild() {
    setRebuilding(true)
    setError(null)
    setLastRebuild(null)
    try {
      const res = await fetch('/api/search-index/rebuild', { method: 'POST' })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${body ? ` - ${body.slice(0, 120)}` : ''}`)
      }
      const result = (await res.json()) as RebuildResult
      setLastRebuild(result)
      haptic('success')
      await fetchStats()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rebuild failed')
      haptic('error')
    } finally {
      setRebuilding(false)
      setConfirmRebuild(false)
    }
  }

  const drift = stats ? stats.totalEntries - stats.indexedDocs : 0
  const driftPct = stats && stats.totalEntries > 0 ? Math.round((drift / stats.totalEntries) * 100) : 0

  return (
    <div className="space-y-4 text-foreground">
      <div className="text-[10px] text-muted-foreground/80 leading-relaxed">
        FTS5 full-text index over <code className="font-mono">transcript_entries</code>. The index is kept in sync via
        triggers on every insert. Use rebuild after a restore or if you suspect drift.
      </div>

      {loading && <div className="text-[10px] text-muted-foreground">Loading index stats...</div>}

      {error && (
        <div className="p-2 border border-destructive/40 bg-destructive/5 rounded text-[10px] text-destructive font-mono">
          {error}
        </div>
      )}

      {stats && !loading && (
        <div className="border border-border rounded p-3 bg-muted/20">
          <StatRow label="Source rows" value={fmtNumber(stats.totalEntries)} hint="rows in transcript_entries" />
          <StatRow label="Indexed docs" value={fmtNumber(stats.indexedDocs)} hint="docs in FTS5 index" />
          <StatRow label="Conversations" value={fmtNumber(stats.conversations)} hint="distinct conversation IDs" />
          <StatRow
            label="Status"
            value={stats.isComplete ? 'in sync' : `drift: ${fmtNumber(drift)} (${driftPct}%)`}
            hint={stats.isComplete ? 'all rows indexed' : 'rebuild recommended'}
          />
        </div>
      )}

      {lastRebuild && (
        <div className="p-2 border border-active/40 bg-active/5 rounded text-[10px] font-mono text-foreground">
          Rebuilt {fmtNumber(lastRebuild.docsIndexed)} docs in {fmtDuration(lastRebuild.durationMs)}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          className="px-3 py-1.5 text-[10px] font-mono border border-border hover:bg-muted cursor-pointer rounded uppercase tracking-wider"
          onClick={fetchStats}
          disabled={loading || rebuilding}
        >
          refresh
        </button>
        <span className="flex-1" />
        {!confirmRebuild ? (
          <button
            type="button"
            className="px-3 py-1.5 text-[10px] font-mono border border-accent/50 text-accent hover:bg-accent/10 cursor-pointer rounded uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => setConfirmRebuild(true)}
            disabled={loading || rebuilding || !stats}
          >
            rebuild index
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">drop + reindex all rows?</span>
            <button
              type="button"
              className="px-3 py-1.5 text-[10px] font-mono border border-border hover:bg-muted cursor-pointer rounded uppercase tracking-wider"
              onClick={() => setConfirmRebuild(false)}
              disabled={rebuilding}
            >
              cancel
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-[10px] font-mono border border-destructive/60 text-destructive hover:bg-destructive/10 cursor-pointer rounded uppercase tracking-wider"
              onClick={handleRebuild}
              disabled={rebuilding}
            >
              {rebuilding ? 'rebuilding...' : 'confirm rebuild'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function SearchIndexManagerDialog({
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
          <DialogTitle className="text-accent font-bold uppercase tracking-wider text-[10px]">Search Index</DialogTitle>
        </div>
        <div className="px-6 pb-6 overflow-y-auto">
          <SearchIndexManager />
        </div>
      </DialogContent>
    </Dialog>
  )
}
