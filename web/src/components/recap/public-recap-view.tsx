/**
 * Public recap viewer mounted when the SPA enters share mode with
 * kind='recap'. Reads /shared/public/recap/:token (no auth, token is the
 * capability) and renders the markdown standalone -- no project chrome,
 * no sidebar, no header.
 */

import { useEffect, useState } from 'react'
import { Markdown } from '@/components/markdown'

interface PublicRecap {
  recapId: string
  title?: string
  subtitle?: string
  periodLabel: string
  periodStart: number
  periodEnd: number
  timeZone: string
  model?: string
  markdown: string
  llmCostUsd: number
  completedAt?: number
  shareLabel?: string
  expiresAt?: number
}

function formatRange(r: PublicRecap): string {
  const start = new Date(r.periodStart).toISOString().slice(0, 10)
  const end = new Date(r.periodEnd).toISOString().slice(0, 10)
  return start === end ? start : `${start} - ${end}`
}

export function PublicRecapView({ token }: { token: string }) {
  const [state, setState] = useState<{ recap: PublicRecap | null; error: string | null; loading: boolean }>({
    recap: null,
    error: null,
    loading: true,
  })

  useEffect(() => {
    let cancelled = false
    fetch(`/shared/public/recap/${encodeURIComponent(token)}`)
      .then(async res => {
        if (cancelled) return
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          setState({ recap: null, error: body.error || `share unavailable (${res.status})`, loading: false })
          return
        }
        const recap = (await res.json()) as PublicRecap
        setState({ recap, error: null, loading: false })
      })
      .catch(err => {
        if (cancelled) return
        setState({ recap: null, error: String(err), loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [token])

  if (state.loading) {
    return <div className="flex items-center justify-center min-h-screen text-sm text-muted-foreground">Loading...</div>
  }
  if (state.error || !state.recap) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 gap-2 text-center">
        <div className="text-base font-medium">Share unavailable</div>
        <div className="text-xs text-muted-foreground">{state.error || 'unknown error'}</div>
      </div>
    )
  }
  const r = state.recap
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <header className="mb-6 pb-4 border-b border-border">
          <h1 className="text-2xl font-semibold">{r.title || `Recap ${r.recapId.slice(0, 12)}`}</h1>
          {r.subtitle && <p className="italic text-muted-foreground mt-1">{r.subtitle}</p>}
          <p className="text-xs text-muted-foreground mt-2">
            {formatRange(r)} - {r.periodLabel}
            {r.model ? ` - ${r.model}` : ''}
            {r.expiresAt ? ` - share expires ${new Date(r.expiresAt).toISOString().slice(0, 10)}` : ''}
          </p>
        </header>
        <article className="prose prose-sm max-w-none dark:prose-invert">
          <Markdown copyable>{r.markdown}</Markdown>
        </article>
      </div>
    </div>
  )
}
