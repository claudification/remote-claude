/**
 * TranscriptView - Virtualized transcript renderer.
 * Uses @tanstack/react-virtual for efficient rendering of large transcript streams.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import type { TranscriptEntry } from '@/lib/types'
import { CompactedDivider, CompactingBanner, MemoizedGroupView } from './group-view'
import { type DisplayGroup, useIncrementalGroups } from './grouping'

interface TranscriptViewProps {
  entries: TranscriptEntry[]
  follow?: boolean
  showThinking?: boolean
  onUserScroll?: () => void
  onReachedBottom?: () => void
}

export function TranscriptView({
  entries,
  follow = false,
  showThinking = false,
  onUserScroll,
  onReachedBottom,
}: TranscriptViewProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const followKilledRef = useRef(false)

  const { resultMap, groups } = useIncrementalGroups(entries)

  // Split: queued groups float at the bottom, non-queued in the virtualizer
  const { mainGroups, queuedGroups } = useMemo(() => {
    const main: DisplayGroup[] = []
    const queued: DisplayGroup[] = []
    for (const g of groups) {
      if (g.queued) queued.push(g)
      else main.push(g)
    }
    return { mainGroups: main, queuedGroups: queued }
  }, [groups])

  // Extract plan content from entries for ExitPlanMode display.
  // Finds the last Write to a plans/*.md path across all entries.
  const planContext = useMemo(() => {
    let content: string | undefined
    let path: string | undefined
    for (const entry of entries) {
      // biome-ignore lint/suspicious/noExplicitAny: transcript entry message has variable structure
      const msg = (entry as any)?.message
      if (msg?.role !== 'assistant') continue
      const blocks = msg.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.name === 'Write' && block.input) {
          const filePath = block.input.file_path as string
          if (filePath && /plans\/[^/]+\.md$/.test(filePath)) {
            content = block.input.content as string
            path = filePath
          }
        }
      }
    }
    return content ? { content, path } : undefined
  }, [entries])

  // Lift subagents selector here (once) instead of per-GroupView (N times)
  // Return a primitive string so Zustand's Object.is check works - avoids re-renders
  // from session_update creating new array references with identical content
  const subagentsSummary = useSessionsStore(state => {
    const session = state.sessions.find(s => s.id === state.selectedSessionId)
    if (!session?.subagents?.length) return ''
    return session.subagents.map(a => `${a.agentId}:${a.status}:${a.description || ''}`).join('|')
  })
  const subagents = useMemo(() => {
    return useSessionsStore.getState().sessions.find(s => s.id === useSessionsStore.getState().selectedSessionId)
      ?.subagents
  }, [subagentsSummary])

  const virtualizer = useVirtualizer({
    count: mainGroups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150,
    overscan: 10,
    getItemKey: index => {
      const g = mainGroups[index]
      return `${g.type}-${g.timestamp}-${index}`
    },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement
      if (!el) return
      const observer = new ResizeObserver(entries => {
        const entry = entries[0]
        if (entry) {
          requestAnimationFrame(() => {
            cb({ width: entry.contentRect.width, height: entry.contentRect.height })
          })
        }
      })
      observer.observe(el)
      return () => observer.disconnect()
    },
  })

  useEffect(() => {
    if (follow) followKilledRef.current = false
  }, [follow])

  const killFollow = useCallback(
    (e: React.WheelEvent | React.TouchEvent) => {
      if (!follow) return
      if ('deltaY' in e && e.deltaY >= 0) return
      followKilledRef.current = true
      onUserScroll?.()
    },
    [follow, onUserScroll],
  )

  useEffect(() => {
    const el = parentRef.current
    if (!el || follow) return
    function handleScroll() {
      if (!el) return
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
      if (atBottom) onReachedBottom?.()
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [follow, onReachedBottom])

  // Scroll to bottom using virtualizer.scrollToIndex for reliable measurement-aware scrolling.
  // Falls back to raw scrollTop for the settle loop (handles dynamic item heights expanding).
  const scrollToBottom = useCallback(() => {
    if (followKilledRef.current) return
    const count = mainGroups.length
    if (count > 0) {
      virtualizer.scrollToIndex(count - 1, { align: 'end' })
    }
    // Settle loop: virtualizer.scrollToIndex positions based on estimated sizes.
    // After items render and measure, scrollHeight may grow. Retry raw scrollTop
    // to catch the final measured height.
    const el = parentRef.current
    if (!el) return
    let lastHeight = -1
    let retries = 0
    function settle() {
      if (!el || followKilledRef.current) return
      el.scrollTop = el.scrollHeight
      if (el.scrollHeight !== lastHeight && retries < 8) {
        lastHeight = el.scrollHeight
        retries++
        requestAnimationFrame(settle)
      }
    }
    requestAnimationFrame(settle)
  }, [mainGroups.length, virtualizer])

  // Subscribe to newDataSeq without triggering re-renders - only used for scroll-to-bottom
  const followRef = useRef(follow)
  followRef.current = follow
  useEffect(() => {
    let lastSeq = useSessionsStore.getState().newDataSeq
    return useSessionsStore.subscribe(state => {
      if (state.newDataSeq !== lastSeq) {
        lastSeq = state.newDataSeq
        if (followRef.current && !followKilledRef.current) scrollToBottom()
      }
    })
  }, [scrollToBottom])

  // Scroll to bottom on initial mount, follow toggle, and entry count changes
  useEffect(() => {
    if (!follow) return
    // Delay slightly to allow virtualizer to process new items and measure
    const timer = setTimeout(scrollToBottom, 50)
    return () => clearTimeout(timer)
  }, [follow, entries.length, scrollToBottom])

  if (mainGroups.length === 0 && queuedGroups.length === 0) {
    return (
      <div className="text-muted-foreground text-center py-10 font-mono">
        <pre className="text-xs">
          {`
┌─────────────────────────┐
│   [ NO TRANSCRIPT ]     │
│   Waiting for data...   │
└─────────────────────────┘
`.trim()}
        </pre>
      </div>
    )
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto p-3 sm:p-4" onWheel={killFollow} onTouchStart={killFollow}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map(virtualItem => (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {(() => {
              const group = mainGroups[virtualItem.index]
              if (group.type === 'compacted') return <CompactedDivider />
              if (group.type === 'compacting') return <CompactingBanner />
              return (
                <MemoizedGroupView
                  group={group}
                  resultMap={resultMap}
                  showThinking={showThinking}
                  subagents={subagents}
                  planContext={planContext}
                />
              )
            })()}
          </div>
        ))}
      </div>
      {/* Queued messages: rendered inline at the bottom of the transcript */}
      {queuedGroups.length > 0 && (
        <div className="mt-2 border-t border-dashed border-amber-500/30 pt-2">
          <div className="text-[10px] font-mono text-amber-500/60 px-1 mb-1">QUEUED</div>
          {queuedGroups.map((group, i) => (
            <MemoizedGroupView
              key={`queued-${group.timestamp}-${i}`}
              group={group}
              resultMap={resultMap}
              showThinking={showThinking}
              subagents={subagents}
            />
          ))}
        </div>
      )}
    </div>
  )
}
