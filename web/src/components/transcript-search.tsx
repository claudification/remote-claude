import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useCommand } from '@/lib/commands'
import { cn, haptic } from '@/lib/utils'

interface ConversationHit {
  conversationId: string
  title: string
  project: string
  hitCount: number
  bestSnippet: string
}

interface SnippetHit {
  conversationId: string
  seq: number
  type: string
  subtype?: string
  snippet: string
  score: number
  createdAt: number
  conversation?: { title?: string; project?: string }
}

interface SearchResponse {
  hits: Array<{
    id: number
    conversationId: string
    seq: number
    type: string
    subtype?: string
    snippet: string
    score: number
    createdAt: number
    conversation?: { id: string; project?: string; title?: string; description?: string }
  }>
  total: number
  query: string
}

type ViewMode = 'conversations' | 'snippets'

function parseConversationHits(data: SearchResponse): ConversationHit[] {
  const grouped = new Map<string, ConversationHit>()
  for (const hit of data.hits) {
    const existing = grouped.get(hit.conversationId)
    if (existing) {
      existing.hitCount++
    } else {
      grouped.set(hit.conversationId, {
        conversationId: hit.conversationId,
        title: hit.conversation?.title || 'untitled',
        project: hit.conversation?.project || '',
        hitCount: 1,
        bestSnippet: hit.snippet || '',
      })
    }
  }
  return [...grouped.values()]
}

function parseSnippetHits(data: SearchResponse): SnippetHit[] {
  return data.hits.map(h => ({
    conversationId: h.conversationId,
    seq: h.seq,
    type: h.type,
    subtype: h.subtype,
    snippet: h.snippet || '',
    score: h.score,
    createdAt: h.createdAt,
    conversation: h.conversation,
  }))
}

function SnippetText({ html }: { html: string }) {
  const sanitized = html
    .replace(/<mark>/g, '\x01')
    .replace(/<\/mark>/g, '\x02')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\x01/g, '<mark class="bg-accent/30 text-accent rounded-sm px-0.5">')
    .replace(/\x02/g, '</mark>')

  return (
    <span className="text-[11px] text-foreground/70 leading-relaxed" dangerouslySetInnerHTML={{ __html: sanitized }} />
  )
}

function formatProject(uri: string): string {
  return uri.replace(/^claude:\/\/default/, '').replace(/^\/Users\/[^/]+\//, '~/')
}

function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 0) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function entryTypeIcon(type: string): string {
  switch (type) {
    case 'user':
      return '▸' // ▸
    case 'assistant':
      return '◂' // ◂
    case 'tool_use':
      return '⚙' // ⚙
    case 'tool_result':
      return '↳' // ↳
    case 'system':
      return '⚑' // ⚑
    default:
      return '·' // ·
  }
}

function SyntaxHints() {
  return (
    <div className="px-4 py-3 border-t border-surface-inset bg-background">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-comment">
        <span>
          <code className="text-primary">"exact phrase"</code>
        </span>
        <span>
          <code className="text-primary">prefix*</code>
        </span>
        <span>
          <code className="text-primary">A AND B</code>
        </span>
        <span>
          <code className="text-primary">A OR B</code>
        </span>
        <span>
          <code className="text-primary">A NOT B</code>
        </span>
        <span>
          <code className="text-primary">NEAR(a b, 5)</code>
        </span>
      </div>
    </div>
  )
}

function EmptyState({ query, loading }: { query: string; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-comment">
        <div className="flex items-center gap-2 text-xs">
          <span className="animate-pulse">searching...</span>
        </div>
      </div>
    )
  }
  if (query) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2">
        <span className="text-comment text-xs">no matches for "{query}"</span>
        <span className="text-[10px] text-comment">try a prefix search: {query}*</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3">
      <div className="text-comment text-2xl font-mono">/</div>
      <span className="text-comment text-xs">search across all conversations</span>
      <span className="text-[10px] text-comment">FTS5 full-text -- stemmed, ranked, fast</span>
    </div>
  )
}

export function TranscriptSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<ViewMode>('conversations')
  const [focusedConversation, setFocusedConversation] = useState<string | null>(null)
  const [conversationHits, setConversationHits] = useState<ConversationHit[]>([])
  const [snippetHits, setSnippetHits] = useState<SnippetHit[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function openSearch() {
    setOpen(true)
    setQuery('')
    setMode('conversations')
    setFocusedConversation(null)
    setConversationHits([])
    setSnippetHits([])
    setActiveIndex(0)
    haptic('tap')
  }

  useCommand('search-transcripts', openSearch, {
    label: 'Search transcripts',
    shortcut: 'mod+f',
    group: 'Navigation',
  })

  useCommand('search-transcripts-alt', openSearch, {
    label: 'Search transcripts',
    shortcut: 'mod+shift+f',
    group: 'Navigation',
  })

  const doSearch = useCallback(async (q: string, conversationId?: string) => {
    if (!q.trim()) {
      setConversationHits([])
      setSnippetHits([])
      setTotal(0)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const params = new URLSearchParams({ q: q.trim(), limit: '50' })
      if (conversationId) params.set('conversation', conversationId)
      const res = await fetch(`/api/search?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as SearchResponse
      setTotal(data.total)

      if (conversationId) {
        setSnippetHits(parseSnippetHits(data))
      } else {
        setConversationHits(parseConversationHits(data))
      }
    } catch {
      setConversationHits([])
      setSnippetHits([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [])

  function handleQueryChange(value: string) {
    setQuery(value)
    setActiveIndex(0)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      if (mode === 'snippets' && focusedConversation) {
        doSearch(value, focusedConversation)
      } else {
        setMode('conversations')
        setFocusedConversation(null)
        doSearch(value)
      }
    }, 150)
  }

  function drillInto(conversationId: string) {
    setMode('snippets')
    setFocusedConversation(conversationId)
    setActiveIndex(0)
    doSearch(query, conversationId)
    haptic('tick')
  }

  function drillOut() {
    setMode('conversations')
    setFocusedConversation(null)
    setActiveIndex(0)
    doSearch(query)
    haptic('tick')
  }

  function navigateToConversation(conversationId: string) {
    const store = useConversationsStore.getState()
    store.selectConversation(conversationId, 'transcript-search')
    setOpen(false)
    haptic('success')
  }

  const items = useMemo(() => {
    if (mode === 'snippets') return snippetHits
    return conversationHits
  }, [mode, conversationHits, snippetHits])

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex(i => Math.min(i + 1, items.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (items.length === 0) return
        if (mode === 'conversations') {
          const hit = conversationHits[activeIndex]
          if (hit) navigateToConversation(hit.conversationId)
        } else {
          const hit = snippetHits[activeIndex]
          if (hit) navigateToConversation(hit.conversationId)
        }
        break
      case 'Escape':
        e.preventDefault()
        if (mode === 'snippets') {
          drillOut()
        } else {
          setOpen(false)
        }
        break
      case 'Backspace':
        if (query === '' && mode === 'snippets') {
          drillOut()
        }
        break
      case 'Tab':
        e.preventDefault()
        if (mode === 'conversations' && items.length > 0) {
          const hit = conversationHits[activeIndex]
          if (hit) drillInto(hit.conversationId)
        }
        break
    }
  }

  // Keep active item scrolled into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const active = list.querySelector('[data-active="true"]')
    if (active) active.scrollIntoView({ block: 'nearest' })
  }, [])

  // Focus input when dialog opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  const focusedTitle = useMemo(() => {
    if (!focusedConversation) return ''
    const hit = conversationHits.find(h => h.conversationId === focusedConversation)
    return hit?.title || focusedConversation.slice(0, 8)
  }, [focusedConversation, conversationHits])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-w-2xl p-0 gap-0 overflow-hidden bg-surface-inset border-primary/20"
        aria-label="Search transcripts"
      >
        <DialogTitle className="sr-only">Search transcripts</DialogTitle>

        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/15">
          <span className="text-primary text-sm shrink-0">/</span>
          {mode === 'snippets' && (
            <button
              type="button"
              onClick={drillOut}
              className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono bg-primary/15 text-primary rounded hover:bg-primary/20 transition-colors cursor-pointer"
            >
              {focusedTitle}
              <span className="ml-1 text-comment">&times;</span>
            </button>
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'snippets' ? `search within ${focusedTitle}...` : 'search all conversations...'}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-comment outline-none font-mono"
            spellCheck={false}
            autoComplete="off"
          />
          {loading && <span className="text-[10px] text-comment animate-pulse shrink-0">...</span>}
          {!loading && total > 0 && <span className="text-[10px] text-comment font-mono shrink-0">{total} hits</span>}
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto max-h-[60vh] min-h-[200px]">
          {items.length === 0 ? (
            <EmptyState query={query} loading={loading} />
          ) : mode === 'conversations' ? (
            conversationHits.map((hit, i) => (
              <button
                key={hit.conversationId}
                type="button"
                data-active={i === activeIndex}
                onClick={() => drillInto(hit.conversationId)}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  'w-full px-4 py-2.5 text-left transition-colors border-b border-surface-inset/80 cursor-pointer',
                  i === activeIndex ? 'bg-primary/12' : 'hover:bg-primary/6',
                )}
              >
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-xs text-foreground font-medium truncate">{hit.title}</span>
                  <span className="text-[10px] text-comment font-mono shrink-0">
                    {hit.hitCount} hit{hit.hitCount > 1 ? 's' : ''}
                  </span>
                  <span className="flex-1" />
                  <span className="text-[10px] text-comment font-mono truncate max-w-[200px]">
                    {formatProject(hit.project)}
                  </span>
                </div>
                <div className="line-clamp-2">
                  <SnippetText html={hit.bestSnippet} />
                </div>
              </button>
            ))
          ) : (
            snippetHits.map((hit, i) => (
              <button
                key={`${hit.conversationId}-${hit.seq}`}
                type="button"
                data-active={i === activeIndex}
                onClick={() => navigateToConversation(hit.conversationId)}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  'w-full px-4 py-2.5 text-left transition-colors border-b border-surface-inset/80 cursor-pointer',
                  i === activeIndex ? 'bg-primary/12' : 'hover:bg-primary/6',
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] text-comment font-mono">
                    {entryTypeIcon(hit.type)} {hit.type}
                    {hit.subtype ? `/${hit.subtype}` : ''}
                  </span>
                  <span className="text-[10px] text-comment">seq {hit.seq}</span>
                  <span className="flex-1" />
                  <span className="text-[10px] text-comment font-mono">{formatTime(hit.createdAt)}</span>
                </div>
                <div className="line-clamp-2">
                  <SnippetText html={hit.snippet} />
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer with syntax hints + shortcuts */}
        <SyntaxHints />
        <div className="px-4 py-2 border-t border-surface-inset bg-background flex items-center gap-3 text-[10px] text-comment">
          <span className="flex items-center gap-1">
            <Kbd className="text-[9px] h-4">&uarr;&darr;</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd className="text-[9px] h-4">Tab</Kbd> drill in
          </span>
          <span className="flex items-center gap-1">
            <Kbd className="text-[9px] h-4">Enter</Kbd> {mode === 'conversations' ? 'expand' : 'go to'}
          </span>
          <span className="flex items-center gap-1">
            <Kbd className="text-[9px] h-4">Esc</Kbd> {mode === 'snippets' ? 'back' : 'close'}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
