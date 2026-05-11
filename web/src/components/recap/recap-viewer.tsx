/**
 * Recap viewer modal.
 *
 * Listens to the rclaude-recap-open CustomEvent (fired by the jobs widget,
 * the share viewer, and any future "open recap" trigger). Fetches the recap
 * over HTTP (so we don't double up on WS chatter) and renders the markdown
 * via the existing Markdown component.
 *
 * When the recap is still running, polls every 2s until status reaches a
 * terminal state. Live progress is also reflected via the recap-jobs store
 * (the widget already subscribes to recap_progress / recap_complete).
 */

import { Dialog as DialogPrimitive } from 'radix-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PeriodRecapDoc } from '@shared/protocol'
import { Markdown } from '@/components/markdown'
import { Kbd } from '@/components/ui/kbd'
import { useRecapJobsStore } from '@/hooks/use-recap-jobs'
import { appendShareParam } from '@/lib/share-mode'
import { haptic } from '@/lib/utils'

const POLL_MS = 2000

type Mode = 'rendered' | 'raw'

interface RecapDocResponse {
  recap?: PeriodRecapDoc
  error?: string
}

function isTerminal(status: PeriodRecapDoc['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

async function fetchRecap(recapId: string): Promise<PeriodRecapDoc | null> {
  const res = await fetch(appendShareParam(`/api/recaps/${encodeURIComponent(recapId)}`))
  if (!res.ok) return null
  const body = (await res.json()) as RecapDocResponse
  return body.recap ?? null
}

function formatPeriod(recap: PeriodRecapDoc): string {
  const start = new Date(recap.periodStart).toISOString().slice(0, 10)
  const end = new Date(recap.periodEnd).toISOString().slice(0, 10)
  return `${start} - ${end}`
}

function ActionButton({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic('tap')
        onClick()
      }}
      title={title}
      className="px-2 py-1 text-xs rounded border border-border hover:bg-muted/60"
    >
      {children}
    </button>
  )
}

function copyMarkdown(recap: PeriodRecapDoc) {
  if (!recap.markdown) return
  navigator.clipboard.writeText(recap.markdown).catch(() => {})
}

function downloadMarkdown(recapId: string) {
  window.open(appendShareParam(`/api/recaps/${encodeURIComponent(recapId)}/markdown`), '_blank')
}

async function shareRecap(recapId: string): Promise<string | null> {
  const res = await fetch(appendShareParam(`/api/recaps/${encodeURIComponent(recapId)}/share`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) return null
  const body = (await res.json()) as { token?: string; shareUrl?: string }
  return body.shareUrl ?? (body.token ? `${window.location.origin}/r/${body.token}` : null)
}

function RecapHeader({ recap, mode, setMode }: { recap: PeriodRecapDoc; mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="px-4 pt-4 pb-2 border-b border-border shrink-0">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold truncate">{recap.title || `Recap ${recap.recapId.slice(0, 12)}`}</h2>
          {recap.subtitle && <p className="text-xs italic text-muted-foreground mt-0.5">{recap.subtitle}</p>}
          <p className="text-[11px] text-muted-foreground mt-1">
            {formatPeriod(recap)} - {recap.model || 'pending'} - cost ${recap.llmCostUsd.toFixed(4)}
          </p>
        </div>
        <DialogPrimitive.Close className="text-muted-foreground hover:text-foreground p-1" aria-label="Close">
          ✕
        </DialogPrimitive.Close>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton onClick={() => copyMarkdown(recap)} title="Copy markdown to clipboard">
          Copy markdown
        </ActionButton>
        <ActionButton onClick={() => downloadMarkdown(recap.recapId)} title="Download .md">
          Download .md
        </ActionButton>
        <ActionButton
          onClick={async () => {
            const url = await shareRecap(recap.recapId)
            if (url) navigator.clipboard.writeText(url).catch(() => {})
          }}
          title="Create a public share link and copy to clipboard"
        >
          Share link
        </ActionButton>
        <ActionButton
          onClick={() => setMode(mode === 'raw' ? 'rendered' : 'raw')}
          title={mode === 'raw' ? 'Show rendered markdown' : 'Show raw markdown source'}
        >
          {mode === 'raw' ? 'View rendered' : 'View raw'}
        </ActionButton>
      </div>
    </div>
  )
}

function StreamingState({ recap }: { recap: PeriodRecapDoc | null }) {
  // Pull live progress from the jobs store -- it has the freshest broker push.
  const job = useRecapJobsStore(s => (recap ? s.jobs[recap.recapId] : undefined))
  const status = job?.status ?? recap?.status ?? 'queued'
  const progress = job?.progress ?? recap?.progress ?? 0
  const phase = job?.phase ?? recap?.phase ?? ''
  return (
    <div className="px-4 py-6 text-center text-sm">
      <div className="mb-2 text-muted-foreground">
        Generating recap... {status} {phase ? `(${phase})` : ''}
      </div>
      <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden mx-auto max-w-md">
        <div className="h-full bg-cyan-500 transition-all" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
      </div>
      <div className="mt-2 text-xs text-muted-foreground">{progress}%</div>
    </div>
  )
}

export function RecapViewer() {
  const [recapId, setRecapId] = useState<string | null>(null)
  const [recap, setRecap] = useState<PeriodRecapDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('rendered')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const close = useCallback(() => {
    setRecapId(null)
    setRecap(null)
    setError(null)
    setMode('rendered')
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const refresh = useCallback(async (id: string) => {
    const doc = await fetchRecap(id)
    if (!doc) {
      setError('Recap not found or you do not have permission.')
      return
    }
    setRecap(doc)
    setError(null)
  }, [])

  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent).detail as { recapId?: string } | undefined
      if (!detail?.recapId) return
      setRecapId(detail.recapId)
      setRecap(null)
      setError(null)
      setMode('rendered')
      void refresh(detail.recapId)
    }
    window.addEventListener('rclaude-recap-open', onOpen)
    return () => window.removeEventListener('rclaude-recap-open', onOpen)
  }, [refresh])

  // Poll while still running.
  useEffect(() => {
    if (!recapId || !recap) return
    if (isTerminal(recap.status)) return
    pollRef.current = setInterval(() => {
      void refresh(recapId)
    }, POLL_MS)
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [recapId, recap, refresh])

  return (
    <DialogPrimitive.Root open={recapId != null} onOpenChange={open => !open && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(960px,95vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-popover shadow-lg flex flex-col">
          <DialogPrimitive.Title className="sr-only">Recap viewer</DialogPrimitive.Title>
          {error ? (
            <div className="p-6 text-sm text-red-400">{error}</div>
          ) : !recap ? (
            <div className="p-6 text-sm text-muted-foreground">Loading...</div>
          ) : isTerminal(recap.status) && recap.markdown ? (
            <>
              <RecapHeader recap={recap} mode={mode} setMode={setMode} />
              <div className="flex-1 overflow-y-auto px-4 py-3">
                {mode === 'raw' ? (
                  <pre className="text-xs whitespace-pre-wrap break-words bg-muted/30 p-3 rounded">{recap.markdown}</pre>
                ) : (
                  <Markdown copyable>{recap.markdown}</Markdown>
                )}
              </div>
            </>
          ) : (
            <>
              <RecapHeader recap={recap} mode={mode} setMode={setMode} />
              <StreamingState recap={recap} />
            </>
          )}
          <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground flex justify-end shrink-0">
            <Kbd>Esc</Kbd>
            <span className="ml-1">to close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
