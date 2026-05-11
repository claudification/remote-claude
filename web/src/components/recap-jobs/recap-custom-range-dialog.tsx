/**
 * Custom-range date picker for recap_create. Two HTML date inputs (start/end)
 * driven by browser TZ; on confirm, computes unix-ms boundaries (start of
 * start day -> end of end day in browser TZ) and dispatches recap_create.
 */

import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { useKeyLayer } from '@/lib/key-layers'
import { haptic } from '@/lib/utils'
import { createRecap } from './recap-submenu'

interface DialogOptions {
  projectUri: string
}

interface DialogState {
  open: boolean
  options: DialogOptions | null
}

let _openDialog: ((options: DialogOptions) => void) | null = null

export function openRecapCustomRangeDialog(options: DialogOptions): void {
  _openDialog?.(options)
}

function isoLocalDay(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function isoToday(): string {
  return isoLocalDay(new Date())
}

function dateToStartMs(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime()
}

function dateToEndMs(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime()
}

export function RecapCustomRangeDialog() {
  const [state, setState] = useState<DialogState>({ open: false, options: null })
  const today = isoToday()
  const [startStr, setStartStr] = useState(today)
  const [endStr, setEndStr] = useState(today)
  const [error, setError] = useState<string | null>(null)
  const startRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    _openDialog = options => {
      setState({ open: true, options })
      setError(null)
      const t = new Date()
      const start = new Date(t.getTime() - 7 * 24 * 60 * 60 * 1000)
      setStartStr(isoLocalDay(start))
      setEndStr(isoLocalDay(t))
      setTimeout(() => startRef.current?.focus(), 50)
    }
    return () => {
      _openDialog = null
    }
  }, [])

  function close() {
    setState({ open: false, options: null })
  }

  function submit() {
    const startMs = dateToStartMs(startStr)
    const endMs = dateToEndMs(endStr)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      setError('Invalid date.')
      return
    }
    if (startMs > endMs) {
      setError('Start must be on or before end.')
      return
    }
    const projectUri = state.options?.projectUri
    if (!projectUri) {
      setError('No project selected.')
      return
    }
    haptic('success')
    createRecap({ projectUri, label: 'custom', start: startMs, end: endMs })
    close()
  }

  useKeyLayer(
    {
      Enter: () => {
        if (state.open) submit()
      },
      Escape: () => {
        if (state.open) close()
      },
    },
    { enabled: state.open },
  )

  return (
    <DialogPrimitive.Root open={state.open} onOpenChange={open => !open && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-popover p-4 shadow-lg">
          <DialogPrimitive.Title className="text-sm font-medium mb-1">Custom date range</DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-xs text-muted-foreground mb-3">
            Generate a recap for the chosen window.
          </DialogPrimitive.Description>
          <div className="space-y-3">
            <label className="block text-xs">
              <span className="block mb-1 text-muted-foreground">Start</span>
              <input
                ref={startRef}
                type="date"
                value={startStr}
                max={endStr}
                onChange={e => setStartStr(e.target.value)}
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="block mb-1 text-muted-foreground">End</span>
              <input
                type="date"
                value={endStr}
                min={startStr}
                max={today}
                onChange={e => setEndStr(e.target.value)}
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
              />
            </label>
            {error && <div className="text-xs text-red-400">{error}</div>}
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="px-3 py-1.5 text-xs rounded border border-border hover:bg-muted/50"
            >
              Cancel <Kbd>Esc</Kbd>
            </button>
            <button
              type="button"
              onClick={submit}
              className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Generate <Kbd>Enter</Kbd>
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
