/**
 * Dialog Modal
 *
 * Full-screen overlay (mobile) / centered modal (desktop) that renders
 * the dialog layout and collects user input.
 *
 * Features:
 * - Countdown timer (subtle, top of dialog)
 * - Auto-extends timeout on user interaction (50% rule)
 * - Buttons record their id in _action but don't dismiss (only Submit/Next does)
 */

import { X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { cn, haptic } from '@/lib/utils'
import { ComponentRenderer, type DialogFormState } from './dialog-renderer'
import type { DialogComponent, DialogLayout, DialogResult } from './types'

// Initialize form state from component defaults (recursively)
function collectDefaults(components: DialogComponent[], values: Record<string, unknown>): void {
  for (const comp of components) {
    switch (comp.type) {
      case 'Options':
        if (comp.default !== undefined) values[comp.id] = comp.default
        break
      case 'TextInput':
        if (comp.default !== undefined) values[comp.id] = comp.default
        break
      case 'Toggle':
        values[comp.id] = comp.default ?? false
        break
      case 'Slider':
        values[comp.id] = comp.default ?? comp.min ?? 0
        break
      case 'ImagePicker':
        break
      case 'Stack':
      case 'Grid':
      case 'Group':
        collectDefaults(comp.children, values)
        break
    }
  }
}

function getInitialValues(layout: DialogLayout): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  if (layout.body) {
    collectDefaults(layout.body, values)
  } else if (layout.pages) {
    for (const page of layout.pages) {
      collectDefaults(page.body, values)
    }
  }
  return values
}

function collectRequired(components: DialogComponent[]): string[] {
  const ids: string[] = []
  for (const comp of components) {
    if ('required' in comp && comp.required && 'id' in comp) {
      ids.push(comp.id)
    }
    if ('children' in comp) {
      ids.push(...collectRequired(comp.children))
    }
  }
  return ids
}

function hasValue(val: unknown): boolean {
  if (val === undefined || val === null || val === '') return false
  if (Array.isArray(val)) return val.length > 0
  return true
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`
}

interface DialogModalProps {
  layout: DialogLayout
  onSubmit: (result: DialogResult) => void
  onCancel: () => void
  onKeepalive?: () => void
}

export const DialogModal = memo(function DialogModal({ layout, onSubmit, onCancel, onKeepalive }: DialogModalProps) {
  const [values, setValues] = useState(() => getInitialValues(layout))
  const [activePage, setActivePage] = useState(0)
  const [lastAction, setLastAction] = useState<string | null>(null)
  const timeoutSec = layout.timeout ?? 300
  const [remaining, setRemaining] = useState(timeoutSec)
  const lastInteractionRef = useRef(Date.now())

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) {
          clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // Send keepalive on user interaction and reset local countdown
  const onInteraction = useCallback(() => {
    const now = Date.now()
    // Debounce: max 1 keepalive per second
    if (now - lastInteractionRef.current < 1000) return
    lastInteractionRef.current = now

    // Reset local countdown to at least 50% of original
    const minRemaining = Math.ceil(timeoutSec * 0.5)
    setRemaining(prev => Math.max(prev, minRemaining))

    // Tell the server to extend
    onKeepalive?.()
  }, [timeoutSec, onKeepalive])

  const pages = useMemo(() => {
    if (layout.pages) return layout.pages
    if (layout.body) return [{ label: '', body: layout.body }]
    return []
  }, [layout])

  const isMultiPage = pages.length > 1
  const isLastPage = activePage >= pages.length - 1
  const currentPage = pages[activePage]

  const form: DialogFormState = useMemo(
    () => ({
      values,
      setValue: (id: string, value: unknown) => {
        setValues(prev => ({ ...prev, [id]: value }))
        onInteraction()
      },
      activeAction: lastAction,
    }),
    [values, onInteraction, lastAction],
  )

  const handleSubmit = useCallback(
    (actionId = 'submit') => {
      haptic('success')
      // Clean up result: rename internal keys to user-friendly names
      const cleaned: Record<string, unknown> = {}
      const optionNotes: Record<string, string> = {}
      for (const [k, v] of Object.entries(values)) {
        // Page notes: _page_notes_0 -> notes (single page) or notes_Page1 (multi)
        if (k.startsWith('_page_notes_')) {
          if (typeof v === 'string' && v.trim()) {
            const idx = Number.parseInt(k.slice('_page_notes_'.length), 10)
            const pageLabel = pages[idx]?.label
            const key = pages.length <= 1 ? 'notes' : `notes_${pageLabel || `page${idx + 1}`}`
            cleaned[key] = v.trim()
          }
          continue
        }
        // Option notes: {id}_note_{value} -> collected into {id}_notes
        const noteMatch = k.match(/^(.+)_note_(.+)$/)
        if (noteMatch) {
          if (typeof v === 'string' && v.trim()) {
            const optId = noteMatch[1]
            const optVal = noteMatch[2]
            if (!optionNotes[optId]) optionNotes[optId] = ''
            optionNotes[optId] += (optionNotes[optId] ? '; ' : '') + `${optVal}: ${v.trim()}`
          }
          continue
        }
        cleaned[k] = v
      }
      // Merge option notes
      for (const [id, notes] of Object.entries(optionNotes)) {
        cleaned[`${id}_notes`] = notes
      }
      onSubmit({
        ...cleaned,
        _action: lastAction || actionId,
        _timeout: false,
        _cancelled: false,
      })
    },
    [values, lastAction, pages, onSubmit],
  )

  // Buttons record their action but don't dismiss
  const handleAction = useCallback(
    (actionId: string) => {
      haptic('tap')
      setLastAction(actionId)
      onInteraction()
    },
    [onInteraction],
  )

  const handleCancel = useCallback(() => {
    haptic('error')
    onCancel()
  }, [onCancel])

  const handleNext = useCallback(() => {
    haptic('tap')
    onInteraction()
    if (isLastPage) {
      handleSubmit()
    } else {
      setActivePage(p => p + 1)
    }
  }, [isLastPage, handleSubmit, onInteraction])

  const handlePrev = useCallback(() => {
    haptic('tap')
    onInteraction()
    setActivePage(p => Math.max(0, p - 1))
  }, [onInteraction])

  const allComponents = currentPage?.body || []
  const requiredIds = useMemo(() => collectRequired(allComponents), [allComponents])
  const canProceed = requiredIds.every(id => hasValue(values[id]))

  // Countdown visual state
  const urgent = remaining <= 30
  const critical = remaining <= 10

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleCancel} />

      {/* Modal */}
      <div
        className={cn(
          'relative flex flex-col bg-background border border-border/50 shadow-2xl',
          'w-full h-full sm:w-[560px] sm:max-h-[85vh] sm:h-auto sm:rounded-lg',
        )}
      >
        {/* Countdown bar */}
        <div className="shrink-0 h-0.5 bg-muted/20">
          <div
            className={cn(
              'h-full transition-all duration-1000 ease-linear',
              critical ? 'bg-destructive' : urgent ? 'bg-amber-500' : 'bg-primary/40',
            )}
            style={{ width: `${(remaining / timeoutSec) * 100}%` }}
          />
        </div>

        {/* Header */}
        <div className="flex items-start gap-3 px-4 pt-3 pb-2 border-b border-border/30 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-foreground truncate">{layout.title}</h2>
              <span
                className={cn(
                  'text-[10px] font-mono shrink-0 tabular-nums',
                  critical ? 'text-destructive animate-pulse' : urgent ? 'text-amber-500' : 'text-muted-foreground/50',
                )}
              >
                {formatCountdown(remaining)}
              </span>
            </div>
            {layout.description && (
              <div className="text-sm text-muted-foreground mt-0.5">
                <Markdown>{layout.description}</Markdown>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Page tabs (if multi-page) */}
        {isMultiPage && (
          <div className="flex gap-1 px-4 py-2 border-b border-border/20 shrink-0 overflow-x-auto">
            {pages.map((page, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  haptic('tap')
                  onInteraction()
                  setActivePage(i)
                }}
                className={cn(
                  'px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap',
                  i === activePage
                    ? 'bg-primary/10 text-primary border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                )}
              >
                {page.label || `Page ${i + 1}`}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {currentPage?.body.map((component, i) => (
            <ComponentRenderer key={`${activePage}-${i}`} component={component} form={form} onAction={handleAction} />
          ))}
          {/* Auto-injected notes field -- skip if the page already has a TextInput */}
          {!currentPage?.body.some(c => c.type === 'TextInput') && (
            <div className="pt-1">
              <textarea
                placeholder="Anything to add..."
                value={(values[`_page_notes_${activePage}`] as string) || ''}
                onChange={e => {
                  setValues(prev => ({ ...prev, [`_page_notes_${activePage}`]: e.target.value }))
                  onInteraction()
                }}
                rows={2}
                className="w-full text-sm bg-muted/20 border border-border/30 rounded px-3 py-2 placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-y min-h-10"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-2 px-4 pt-3 sm:pb-3 border-t border-border/30 shrink-0"
          style={{ paddingBottom: 'max(1.25rem, calc(env(safe-area-inset-bottom, 0px) + 0.75rem))' }}
        >
          <Button variant="ghost" onClick={handleCancel}>
            {layout.cancelLabel || 'Cancel'}
          </Button>

          <div className="flex items-center gap-2">
            {lastAction && <span className="text-[10px] text-muted-foreground font-mono">[{lastAction}]</span>}
            {isMultiPage && activePage > 0 && (
              <Button variant="outline" onClick={handlePrev}>
                Back
              </Button>
            )}
            <Button onClick={handleNext} disabled={!canProceed}>
              {isLastPage ? layout.submitLabel || 'Submit' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
})
