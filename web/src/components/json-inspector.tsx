import { Copy, Info } from 'lucide-react'
import { useState } from 'react'
import { create } from 'zustand'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { haptic } from '@/lib/utils'
import JsonHighlight from './json-highlight'

// Global store so dialog state survives virtualizer remounts
interface InspectorStore {
  open: boolean
  title: string
  data: Record<string, unknown> | null
  result?: string
  extra?: Record<string, unknown>
  raw?: unknown
  show: (
    title: string,
    data: Record<string, unknown>,
    result?: string,
    extra?: Record<string, unknown>,
    raw?: unknown,
  ) => void
  close: () => void
}

const useInspectorStore = create<InspectorStore>(set => ({
  open: false,
  title: '',
  data: null,
  result: undefined,
  extra: undefined,
  raw: undefined,
  show: (title, data, result, extra, raw) => set({ open: true, title, data, result, extra, raw }),
  close: () => set({ open: false }),
}))

interface JsonInspectorProps {
  title: string
  data: Record<string, unknown>
  result?: string
  extra?: Record<string, unknown>
  raw?: unknown
}

export function JsonInspector({ title, data, result, extra, raw }: JsonInspectorProps) {
  const show = useInspectorStore(s => s.show)

  return (
    <button
      type="button"
      className="text-muted-foreground/40 hover:text-muted-foreground transition-colors p-0.5"
      title="Inspect raw data"
      onClick={e => {
        e.stopPropagation()
        show(title, data, result, extra, raw)
      }}
    >
      <Info className="w-3 h-3" />
    </button>
  )
}

function CopyBar({
  title,
  data,
  result,
  extra,
  raw,
}: {
  title: string
  data: Record<string, unknown> | null
  result?: string
  extra?: Record<string, unknown>
  raw?: unknown
}) {
  const [copied, setCopied] = useState(false)
  function handleCopy() {
    const out: Record<string, unknown> = {}
    if (raw !== undefined) out.raw = raw
    if (data) out.input = data
    if (result) out.result = result
    if (extra && Object.keys(extra).length > 0) out.extra = extra
    navigator.clipboard.writeText(JSON.stringify(out, null, 2))
    haptic('success')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="p-4 border-b border-border flex items-center gap-2">
      <DialogTitle className="flex-1">{title}</DialogTitle>
      <button
        type="button"
        onClick={handleCopy}
        className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded transition-colors"
      >
        <Copy className="w-3 h-3" />
        {copied ? 'COPIED' : 'COPY'}
      </button>
    </div>
  )
}

/** Render once at the top level - dialog is global, not per-item */
export function JsonInspectorDialog() {
  const { open, title, data, result, extra, raw, close } = useInspectorStore()
  const rawIsObject = raw !== undefined && raw !== null && typeof raw === 'object'

  return (
    <Dialog
      open={open}
      onOpenChange={v => {
        if (!v) close()
      }}
    >
      <DialogContent>
        <CopyBar title={title} data={data} result={result} extra={extra} raw={raw} />
        <div className="flex-1 overflow-y-auto p-4 font-mono text-xs">
          {open && (
            <div className="space-y-4">
              {raw !== undefined && (
                <section>
                  <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-2">Raw</div>
                  {rawIsObject ? (
                    <JsonHighlight data={raw as Record<string, unknown>} />
                  ) : (
                    <pre className="whitespace-pre-wrap text-foreground/80 bg-black/20 p-3 max-h-60 overflow-auto">
                      {String(raw)}
                    </pre>
                  )}
                </section>
              )}
              {data && (
                <section>
                  <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-2">Input</div>
                  <JsonHighlight data={data} />
                </section>
              )}
              {result && (
                <section>
                  <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-2">Result</div>
                  <pre className="whitespace-pre-wrap text-foreground/80 bg-black/20 p-3 max-h-60 overflow-auto">
                    {result}
                  </pre>
                </section>
              )}
              {extra && Object.keys(extra).length > 0 && (
                <section>
                  <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-2">Extra</div>
                  <JsonHighlight data={extra} />
                </section>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
