import { Info } from 'lucide-react'
import { create } from 'zustand'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import JsonHighlight from './json-highlight'

// Global store so dialog state survives virtualizer remounts
interface InspectorStore {
  open: boolean
  title: string
  data: Record<string, unknown> | null
  result?: string
  extra?: Record<string, unknown>
  show: (title: string, data: Record<string, unknown>, result?: string, extra?: Record<string, unknown>) => void
  close: () => void
}

const useInspectorStore = create<InspectorStore>(set => ({
  open: false,
  title: '',
  data: null,
  result: undefined,
  extra: undefined,
  show: (title, data, result, extra) => set({ open: true, title, data, result, extra }),
  close: () => set({ open: false }),
}))

interface JsonInspectorProps {
  title: string
  data: Record<string, unknown>
  result?: string
  extra?: Record<string, unknown>
}

export function JsonInspector({ title, data, result, extra }: JsonInspectorProps) {
  const show = useInspectorStore(s => s.show)

  return (
    <button
      type="button"
      className="text-muted-foreground/40 hover:text-muted-foreground transition-colors p-0.5"
      title="Inspect raw data"
      onClick={e => {
        e.stopPropagation()
        show(title, data, result, extra)
      }}
    >
      <Info className="w-3 h-3" />
    </button>
  )
}

/** Render once at the top level - dialog is global, not per-item */
export function JsonInspectorDialog() {
  const { open, title, data, result, extra, close } = useInspectorStore()

  return (
    <Dialog
      open={open}
      onOpenChange={v => {
        if (!v) close()
      }}
    >
      <DialogContent>
        <div className="p-4 border-b border-border">
          <DialogTitle>{title}</DialogTitle>
        </div>
        <div className="flex-1 overflow-y-auto p-4 font-mono text-xs">
          {open && data && (
            <div className="space-y-4">
              <section>
                <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-2">Input</div>
                <JsonHighlight data={data} />
              </section>
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
