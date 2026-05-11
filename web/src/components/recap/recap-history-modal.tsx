/**
 * Recap history modal. Listens to rclaude-recap-history-open events fired
 * by RecapSubmenu / palette commands. Lists prior recaps for a project (or
 * across all accessible projects when no projectUri is given). Clicking a
 * row opens the recap viewer via rclaude-recap-open.
 */

import type { RecapSummary } from '@shared/protocol'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useCallback, useEffect, useState } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { appendShareParam } from '@/lib/share-mode'
import { haptic } from '@/lib/utils'

interface OpenDetail {
  projectUri?: string
}

interface ListResponse {
  recaps?: RecapSummary[]
}

function statusBadge(status: RecapSummary['status']): string {
  if (status === 'done') return 'text-green-500'
  if (status === 'failed') return 'text-red-400'
  if (status === 'cancelled') return 'text-zinc-400'
  return 'text-cyan-400'
}

async function fetchList(projectUri?: string): Promise<RecapSummary[]> {
  const url = new URL('/api/recaps', window.location.origin)
  if (projectUri) url.searchParams.set('projectUri', projectUri)
  url.searchParams.set('limit', '100')
  const res = await fetch(appendShareParam(url.pathname + url.search))
  if (!res.ok) return []
  const body = (await res.json()) as ListResponse
  return body.recaps ?? []
}

function formatRange(s: RecapSummary): string {
  const start = new Date(s.periodStart).toISOString().slice(0, 10)
  const end = new Date(s.periodEnd).toISOString().slice(0, 10)
  return start === end ? start : `${start} - ${end}`
}

export function RecapHistoryModal() {
  const [open, setOpen] = useState(false)
  const [projectUri, setProjectUri] = useState<string | undefined>(undefined)
  const [recaps, setRecaps] = useState<RecapSummary[]>([])
  const [loading, setLoading] = useState(false)

  const close = useCallback(() => {
    setOpen(false)
    setRecaps([])
  }, [])

  const load = useCallback(async (proj?: string) => {
    setLoading(true)
    try {
      const items = await fetchList(proj)
      setRecaps(items)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    function onOpen(e: Event) {
      const detail = ((e as CustomEvent).detail || {}) as OpenDetail
      setProjectUri(detail.projectUri)
      setOpen(true)
      void load(detail.projectUri)
    }
    window.addEventListener('rclaude-recap-history-open', onOpen)
    return () => window.removeEventListener('rclaude-recap-history-open', onOpen)
  }, [load])

  function openViewer(recapId: string) {
    haptic('tap')
    window.dispatchEvent(new CustomEvent('rclaude-recap-open', { detail: { recapId } }))
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={o => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(720px,95vw)] max-h-[80vh] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-popover shadow-lg flex flex-col">
          <div className="px-4 pt-4 pb-2 border-b border-border flex items-center justify-between shrink-0">
            <div>
              <DialogPrimitive.Title className="text-sm font-semibold">
                Past recaps{' '}
                {projectUri && projectUri !== '*' ? `for ${projectUri.split('/').filter(Boolean).pop()}` : '(all)'}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-xs text-muted-foreground mt-0.5">
                {recaps.length} recap{recaps.length === 1 ? '' : 's'}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="text-muted-foreground hover:text-foreground p-1">✕</DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>}
            {!loading && recaps.length === 0 && (
              <div className="px-3 py-6 text-xs text-muted-foreground text-center">No recaps yet for this scope.</div>
            )}
            {recaps.map(r => (
              <button
                key={r.id}
                type="button"
                onClick={() => openViewer(r.id)}
                className="w-full text-left rounded-md border border-border bg-card hover:bg-muted/50 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium truncate">{r.title || r.id}</div>
                  <div className={`text-[10px] uppercase tracking-wide ${statusBadge(r.status)}`}>{r.status}</div>
                </div>
                {r.subtitle && <div className="text-xs italic text-muted-foreground mt-0.5 truncate">{r.subtitle}</div>}
                <div className="text-[10px] text-muted-foreground mt-1">
                  {formatRange(r)} - {r.periodLabel} - {r.model || 'pending'}
                  {r.llmCostUsd > 0 && ` - $${r.llmCostUsd.toFixed(4)}`}
                </div>
                {r.error && <div className="text-[10px] text-red-400 mt-0.5 truncate">{r.error}</div>}
              </button>
            ))}
          </div>
          <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground flex justify-end shrink-0">
            <Kbd>Esc</Kbd>
            <span className="ml-1">to close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
