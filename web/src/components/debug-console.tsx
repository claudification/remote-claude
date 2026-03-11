import { Copy, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type LogEntry, clearLog, copyLogText, getLogEntries, subscribeLog } from '@/lib/debug-log'

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-yellow-400',
  debug: 'text-cyan-400/70',
  log: 'text-foreground/80',
}

function LogLine({ entry }: { entry: LogEntry }) {
  const ts = new Date(entry.t).toISOString().slice(11, 23)
  return (
    <div className={`flex gap-2 font-mono text-[11px] leading-relaxed ${LEVEL_COLORS[entry.level] || 'text-foreground'}`}>
      <span className="text-muted-foreground/50 shrink-0 select-none">{ts}</span>
      <span className="text-muted-foreground/50 shrink-0 w-10 select-none">{entry.level.toUpperCase()}</span>
      <span className="whitespace-pre-wrap break-all">{entry.args}</span>
    </div>
  )
}

export function DebugConsole({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState(getLogEntries)
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

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

  // Auto-scroll on mount
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

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] flex flex-col bg-background/95 backdrop-blur border-t border-border shadow-2xl"
      style={{ height: '40vh', minHeight: '200px' }}
    >
      {/* Toolbar */}
      <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-border">
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
            {copied ? <span className="text-[10px] font-mono text-green-400">copied</span> : <Copy className="w-3.5 h-3.5" />}
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
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {/* Log area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-auto px-3 py-1"
      >
        {entries.length === 0 && (
          <div className="text-muted-foreground/50 text-xs font-mono py-4 text-center">No log entries yet</div>
        )}
        {entries.map((entry, i) => (
          <LogLine key={i} entry={entry} />
        ))}
      </div>
    </div>
  )
}
