import { Copy, Maximize2, Minimize2, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { clearLog, copyLogText, getLogEntries, type LogEntry, subscribeLog } from '@/lib/debug-log'

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-yellow-400',
  debug: 'text-cyan-400/70',
  log: 'text-foreground/80',
}

const MIN_HEIGHT = 120
const DEFAULT_HEIGHT = 240
const MAX_HEIGHT_RATIO = 0.7

function LogLine({ entry }: { entry: LogEntry }) {
  const ts = new Date(entry.t).toISOString().slice(11, 23)
  return (
    <div
      className={`flex gap-2 font-mono text-[11px] leading-relaxed ${LEVEL_COLORS[entry.level] || 'text-foreground'}`}
    >
      <span className="text-muted-foreground/50 shrink-0 select-none">{ts}</span>
      <span className="text-muted-foreground/50 shrink-0 w-10 select-none">{entry.level.toUpperCase()}</span>
      <span className="whitespace-pre-wrap break-all">{entry.args}</span>
    </div>
  )
}

export function DebugConsole({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState(getLogEntries)
  const [copied, setCopied] = useState(false)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [fullscreen, setFullscreen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  useEffect(() => {
    return subscribeLog(() => {
      setEntries([...getLogEntries()])
      if (followRef.current && scrollRef.current) {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
        })
      }
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30
  }

  function handleCopy() {
    navigator.clipboard.writeText(copyLogText(200))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function handleClear() {
    clearLog()
    setEntries([])
  }

  // Drag resize from top edge
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startH: height }
      const el = e.currentTarget as HTMLElement
      el.setPointerCapture(e.pointerId)
    },
    [height],
  )

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const maxH = window.innerHeight * MAX_HEIGHT_RATIO
    const delta = dragRef.current.startY - e.clientY
    const newH = Math.min(maxH, Math.max(MIN_HEIGHT, dragRef.current.startH + delta))
    setHeight(newH)
  }, [])

  const onPointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  const panelHeight = fullscreen ? '100vh' : `${height}px`

  return (
    <div
      className={`shrink-0 flex flex-col bg-background border-t border-border ${fullscreen ? 'fixed inset-0 z-[60]' : ''}`}
      style={{ height: panelHeight }}
    >
      {/* Resize handle */}
      {!fullscreen && (
        <div
          className="h-1.5 cursor-row-resize bg-transparent hover:bg-accent/30 transition-colors shrink-0"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          title="Drag to resize"
        />
      )}
      {/* Toolbar */}
      <div className="shrink-0 flex items-center justify-between px-3 py-1 border-b border-border">
        <span className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
          Debug Console ({entries.length})
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            title="Copy last 200 lines"
          >
            {copied ? (
              <span className="text-[10px] font-mono text-green-400">copied</span>
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            title="Clear logs"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setFullscreen(f => !f)}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {/* Log area */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-auto px-3 py-1">
        {entries.length === 0 && (
          <div className="text-muted-foreground/50 text-xs font-mono py-4 text-center">No log entries yet</div>
        )}
        {entries.map((entry, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: display-only log entries, no stable IDs
          <LogLine key={i} entry={entry} />
        ))}
      </div>
    </div>
  )
}
