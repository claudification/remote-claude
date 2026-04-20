import { ChevronRight, Filter, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type JsonStreamMessage, useSessionsStore } from '@/hooks/use-sessions'
import { cn } from '@/lib/utils'

interface JsonStreamPanelProps {
  wrapperId: string
}

interface ParsedLine {
  raw: string
  parsed: Record<string, unknown> | null
  type: string | null
}

const MAX_LINES = 2000
const FILTER_TYPES = ['all', 'assistant', 'user', 'tool_use', 'tool_result', 'system', 'result'] as const
type FilterType = (typeof FILTER_TYPES)[number]

function parseLine(raw: string): ParsedLine {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const type = (parsed.type as string) || null
    return { raw, parsed, type }
  } catch {
    return { raw, parsed: null, type: null }
  }
}

function typeColor(type: string | null): string {
  switch (type) {
    case 'assistant':
      return 'text-emerald-400'
    case 'user':
      return 'text-blue-400'
    case 'tool_use':
      return 'text-amber-400'
    case 'tool_result':
      return 'text-orange-400'
    case 'result':
      return 'text-violet-400'
    case 'system':
      return 'text-rose-400'
    default:
      return 'text-muted-foreground'
  }
}

function StreamLine({ line, index }: { line: ParsedLine; index: number }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="group border-b border-border/30 hover:bg-muted/30">
      <button
        type="button"
        className="w-full text-left flex items-start gap-2 px-3 py-1 font-mono text-[11px]"
        onClick={() => line.parsed && setExpanded(!expanded)}
      >
        <span className="shrink-0 text-muted-foreground/50 w-8 text-right tabular-nums select-none">{index + 1}</span>
        {line.parsed ? (
          <ChevronRight
            className={cn(
              'shrink-0 w-3 h-3 mt-0.5 transition-transform text-muted-foreground/50',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="shrink-0 w-3" />
        )}
        <span className={cn('shrink-0', typeColor(line.type))}>{line.type || 'raw'}</span>
        {!expanded && (
          <span className="truncate text-muted-foreground/70">
            {line.parsed ? summarizeLine(line.parsed) : line.raw}
          </span>
        )}
      </button>
      {expanded && line.parsed && (
        <pre className="pl-16 pr-3 pb-2 text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(line.parsed, null, 2)}
        </pre>
      )}
    </div>
  )
}

function summarizeLine(obj: Record<string, unknown>): string {
  if (obj.type === 'assistant' && obj.message) {
    const msg = obj.message as Record<string, unknown>
    const content = msg.content as Array<Record<string, unknown>> | undefined
    if (content?.[0]?.type === 'text') return truncate(content[0].text as string, 120)
    if (content?.[0]?.type === 'tool_use') return `tool: ${content[0].name}`
    return `${content?.length || 0} content block(s)`
  }
  if (obj.type === 'tool_result') {
    const content = obj.content as string | undefined
    if (typeof content === 'string') return truncate(content, 120)
  }
  if (obj.type === 'result') {
    const result = obj.result as Record<string, unknown> | undefined
    if (result?.type) return `type=${result.type}`
  }
  const keys = Object.keys(obj).filter(k => k !== 'type')
  return keys.slice(0, 4).join(', ')
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, ' ')
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine
}

export function JsonStreamPanel({ wrapperId }: JsonStreamPanelProps) {
  const sendWsMessage = useSessionsStore(state => state.sendWsMessage)
  const setJsonStreamHandler = useSessionsStore(state => state.setJsonStreamHandler)
  const isConnected = useSessionsStore(state => state.isConnected)
  const [lines, setLines] = useState<ParsedLine[]>([])
  const [filter, setFilter] = useState<FilterType>('all')
  const [showFilter, setShowFilter] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const attachedRef = useRef(false)

  const handleMessage = useCallback(
    (msg: JsonStreamMessage) => {
      if (msg.wrapperId !== wrapperId) return
      const newLines = msg.lines.map(parseLine)
      if (newLines.length === 0) return
      setLines(prev => {
        if (msg.isBackfill) return newLines
        const combined = [...prev, ...newLines]
        return combined.length > MAX_LINES ? combined.slice(-MAX_LINES) : combined
      })
    },
    [wrapperId],
  )

  // Attach/detach lifecycle
  useEffect(() => {
    setJsonStreamHandler(handleMessage)
    sendWsMessage({ type: 'json_stream_attach', wrapperId })
    attachedRef.current = true

    return () => {
      setJsonStreamHandler(null)
      if (attachedRef.current) {
        sendWsMessage({ type: 'json_stream_detach', wrapperId })
        attachedRef.current = false
      }
    }
  }, [wrapperId, sendWsMessage, setJsonStreamHandler, handleMessage])

  // Re-attach on WS reconnect
  useEffect(() => {
    if (!isConnected) return
    sendWsMessage({ type: 'json_stream_attach', wrapperId })
    attachedRef.current = true
  }, [isConnected, wrapperId, sendWsMessage])

  // Auto-scroll
  useEffect(() => {
    if (!autoScrollRef.current || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [lines])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    autoScrollRef.current = atBottom
  }

  const filtered = filter === 'all' ? lines : lines.filter(l => l.type === filter)

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/30">
        <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">Raw JSON Stream</span>
        <span className="text-[10px] text-muted-foreground/60 tabular-nums">{lines.length} lines</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowFilter(!showFilter)}
            className={cn(
              'p-1 rounded hover:bg-muted transition-colors',
              showFilter && 'bg-muted text-foreground',
              !showFilter && 'text-muted-foreground',
            )}
            title="Filter by message type"
          >
            <Filter className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setLines([])
              autoScrollRef.current = true
            }}
            className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Filter bar */}
      {showFilter && (
        <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-border bg-muted/20">
          {FILTER_TYPES.map(t => (
            <button
              type="button"
              key={t}
              onClick={() => setFilter(t)}
              className={cn(
                'px-2 py-0.5 text-[10px] rounded transition-colors font-mono',
                filter === t
                  ? 'bg-accent/20 text-accent font-bold'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
            >
              {t}
            </button>
          ))}
          {filter !== 'all' && (
            <span className="text-[10px] text-muted-foreground/50 ml-1">
              {filtered.length}/{lines.length}
            </span>
          )}
        </div>
      )}

      {/* Disconnected banner */}
      {!isConnected && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-red-500/30 bg-red-500/10">
          <WifiOff className="w-3.5 h-3.5 text-red-400" />
          <span className="text-xs font-mono text-red-400">Disconnected - waiting for reconnect...</span>
        </div>
      )}

      {/* Lines */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs font-mono">
            {lines.length === 0 ? 'Waiting for stream data...' : 'No matching lines'}
          </div>
        ) : (
          filtered.map((line, i) => <StreamLine key={i} line={line} index={i} />)
        )}
      </div>
    </div>
  )
}
