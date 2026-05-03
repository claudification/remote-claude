/**
 * ConversationView - Timeline of inter-project messages between two projects.
 * Chat bubble layout: left = project A, right = project B.
 */

import { ArrowLeft, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn, formatTime } from '@/lib/utils'

interface MessageEntry {
  ts: number
  from: { conversationId: string; project: string; name: string }
  to: { conversationId: string; project: string; name: string }
  intent: string
  conversationId: string
  preview: string
  fullLength: number
}

const INTENT_STYLES: Record<string, string> = {
  request: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
  response: 'bg-green-400/15 text-green-400 border-green-400/30',
  notify: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
  progress: 'bg-zinc-400/15 text-zinc-400 border-zinc-400/30',
}

const API_BASE = `${window.location.protocol}//${window.location.host}`

export function ConversationView({
  projectA,
  projectB,
  nameA,
  nameB,
  onBack,
}: {
  projectA: string
  projectB: string
  nameA: string
  nameB: string
  onBack: () => void
}) {
  const [messages, setMessages] = useState<MessageEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const fetchMessages = useCallback(
    async (before?: number) => {
      try {
        const params = new URLSearchParams({ projectA, projectB, limit: '50' })
        if (before) params.set('before', String(before))
        const res = await fetch(`${API_BASE}/api/links/messages?${params}`)
        if (!res.ok) return
        const data = (await res.json()) as { messages: MessageEntry[]; hasMore: boolean }
        if (before) {
          setMessages(prev => [...data.messages, ...prev])
        } else {
          setMessages(data.messages)
        }
        setHasMore(data.hasMore)
      } catch {
        // network error
      } finally {
        setLoading(false)
      }
    },
    [projectA, projectB],
  )

  useEffect(() => {
    fetchMessages()
  }, [fetchMessages])

  // Auto-scroll to bottom on initial load
  useEffect(() => {
    if (!loading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [loading])

  function loadMore() {
    if (messages.length > 0) {
      fetchMessages(messages[0].ts)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
        <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="text-teal-400 font-bold">{nameA}</span>
          <span className="text-muted-foreground">-</span>
          <span className="text-sky-400 font-bold">{nameB}</span>
        </div>
        <span className="text-[10px] text-muted-foreground ml-auto">{messages.length} messages</span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loading && (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="text-center text-muted-foreground text-xs py-8 font-mono">No messages yet</div>
        )}

        {hasMore && !loading && (
          <button
            type="button"
            onClick={loadMore}
            className="w-full text-center text-[10px] text-muted-foreground hover:text-foreground font-mono py-2"
          >
            Load more
          </button>
        )}

        {messages.map((msg, i) => {
          const isFromA = msg.from.project === projectA
          const bubbleColor = isFromA ? 'bg-teal-600/20 border-teal-600/30' : 'bg-sky-600/20 border-sky-600/30'
          const align = isFromA ? 'items-start' : 'items-end'
          const intentStyle = INTENT_STYLES[msg.intent] || INTENT_STYLES.notify

          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: messages may share timestamp, no stable unique key
            <div key={`${msg.ts}-${i}`} className={cn('flex flex-col', align)}>
              <div className={cn('max-w-[85%] rounded-xl border px-3 py-2', bubbleColor)}>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={cn(
                      'px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider border rounded',
                      intentStyle,
                    )}
                  >
                    {msg.intent}
                  </span>
                  <span className="text-[9px] text-muted-foreground font-mono">{formatTime(msg.ts)}</span>
                </div>
                <div className="text-xs text-foreground/90 whitespace-pre-wrap break-words">{msg.preview}</div>
                {msg.fullLength > msg.preview.length && (
                  <span className="text-[9px] text-muted-foreground/50 mt-1 block">
                    +{msg.fullLength - msg.preview.length} chars truncated
                  </span>
                )}
              </div>
              <span className="text-[8px] text-muted-foreground/40 mt-0.5 px-1">{msg.from.name}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
