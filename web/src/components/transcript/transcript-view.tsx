/**
 * TranscriptView - Virtualized transcript renderer.
 * Uses @tanstack/react-virtual for efficient rendering of large transcript streams.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, Profiler, type ProfilerOnRenderCallback, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { isPerfEnabled, record } from '@/lib/perf-metrics'
import type { TranscriptEntry } from '@/lib/types'
import { Markdown } from '../markdown'
import { CompactedDivider, CompactingBanner, MemoizedGroupView, SkillDivider } from './group-view'
import { type DisplayGroup, useIncrementalGroups } from './grouping'

const EMPTY_STREAMING = ''

/** Isolated streaming text component - subscribes to its own store slice so token updates don't re-render the virtualizer */
const StreamingBlock = memo(function StreamingBlock({ sessionId }: { sessionId: string | null }) {
  const showStreaming = useSessionsStore(state => state.dashboardPrefs.showStreaming !== false)
  const streamingText = useSessionsStore(
    state => (sessionId ? state.streamingText[sessionId] : null) || EMPTY_STREAMING,
  )
  if (!showStreaming || !streamingText) return null
  return (
    <div className="mt-2 pl-4">
      <div className="border-l-2 border-emerald-400/40 pl-3 py-1">
        <div className="text-[10px] text-emerald-400/70 uppercase font-bold tracking-wider mb-1">streaming</div>
        <div className="text-sm opacity-75">
          <Markdown>{streamingText}</Markdown>
          <span className="inline-block w-1.5 h-4 bg-emerald-500 animate-pulse ml-0.5 align-text-bottom" />
        </div>
      </div>
    </div>
  )
})

const VERBS = [
  'Thinking',
  'Reasoning',
  'Pondering',
  'Computing',
  'Processing',
  'Analyzing',
  'Cogitating',
  'Ruminating',
  'Deliberating',
  'Contemplating',
  'Synthesizing',
  'Evaluating',
  'Calculating',
  'Deducing',
  'Inferring',
  'Considering',
  'Brainstorming',
  'Formulating',
  'Assembling',
  'Decoding',
  'Untangling',
  'Composing',
  'Orchestrating',
  'Channeling',
  'Manifesting',
  'Conjuring',
  'Brewing',
  'Crafting',
  'Forging',
  'Weaving',
  'Sculpting',
  'Crunching',
  'Finugeling',
  'Machinating',
  'Scheming',
  'Plotting',
]

/** Shows a fun random verb spinner while the session is active (between UserPromptSubmit and Stop) */
const ThinkingSpinner = memo(function ThinkingSpinner({ sessionId }: { sessionId: string | null }) {
  const session = useSessionsStore(state => state.sessions.find(s => s.id === sessionId))
  const [verb, setVerb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)])
  const [dots, setDots] = useState(0)

  const isActive = session?.status === 'active'
  const tokens = session?.stats?.totalOutputTokens ?? 0

  useEffect(() => {
    if (!isActive) return
    const verbInterval = setInterval(() => {
      setVerb(VERBS[Math.floor(Math.random() * VERBS.length)])
    }, 3000)
    const dotInterval = setInterval(() => {
      setDots(d => (d + 1) % 4)
    }, 400)
    return () => {
      clearInterval(verbInterval)
      clearInterval(dotInterval)
    }
  }, [isActive])

  if (!isActive) return null

  return (
    <div className="mt-2 flex items-center gap-2 px-4 py-1.5 text-[11px] font-mono text-muted-foreground/60">
      <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
      <span className="text-accent/70">
        {verb}
        {'.'.repeat(dots)}
      </span>
      {tokens > 0 && (
        <span className="text-muted-foreground/40 tabular-nums">{(tokens / 1000).toFixed(1)}K tokens</span>
      )}
    </div>
  )
})

let lastVirtualItemCount = 0
let lastTotalGroupCount = 0

const onRenderProfile: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration) => {
  record(
    'render',
    id,
    actualDuration,
    `${phase} base=${baseDuration.toFixed(1)}ms visible=${lastVirtualItemCount}/${lastTotalGroupCount}`,
  )
}

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

  const { getResult, groups } = useIncrementalGroups(entries)

  // Lift settings selectors here (once) instead of per-GroupView (N times)
  const expandAll = useSessionsStore(state => state.expandAll)
  const globalSettings = useSessionsStore(state => state.globalSettings)
  const chatBubbles = useSessionsStore(state => state.dashboardPrefs.chatBubbles)
  const bubbleColor = useSessionsStore(state => state.dashboardPrefs.chatBubbleColor) || 'blue'
  const transcriptSettings = useMemo(
    () => ({
      expandAll,
      userLabel: (globalSettings.userLabel as string)?.trim() || 'USER',
      agentLabel: (globalSettings.agentLabel as string)?.trim() || 'CLAUDE',
      userColor: (globalSettings.userColor as string)?.trim() || '',
      agentColor: (globalSettings.agentColor as string)?.trim() || '',
      userSize: (globalSettings.userSize as string) || '',
      agentSize: (globalSettings.agentSize as string) || '',
      chatBubbles,
      bubbleColor,
    }),
    [expandAll, globalSettings, chatBubbles, bubbleColor],
  )

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
  // IMPORTANT: return stable reference when content hasn't changed to avoid busting memo on all GroupViews.
  const planContextRef = useRef<{ content: string; path?: string } | undefined>(undefined)
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
    const next = content ? { content, path } : undefined
    const prev = planContextRef.current
    if (prev?.content === next?.content && prev?.path === next?.path) return prev
    planContextRef.current = next
    return next
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

  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)

  const virtualizer = useVirtualizer({
    count: mainGroups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 3,
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
    <div
      ref={parentRef}
      className="h-full overflow-y-auto p-3 sm:p-4"
      style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
      onWheel={killFollow}
      onTouchStart={killFollow}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        <Profiler id="TranscriptGroups" onRender={onRenderProfile}>
          {((lastVirtualItemCount = virtualizer.getVirtualItems().length),
          (lastTotalGroupCount = mainGroups.length),
          virtualizer.getVirtualItems()).map(virtualItem => (
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
                if (group.type === 'skill') {
                  const entry = group.entries[0] as {
                    message?: { content?: string | Array<{ type: string; text?: string }> }
                  }
                  const content = Array.isArray(entry?.message?.content)
                    ? entry.message.content
                        .filter(b => b.type === 'text')
                        .map(b => b.text || '')
                        .join('')
                    : ''
                  return <SkillDivider name={group.skillName || 'skill'} content={content} />
                }
                return (
                  <MemoizedGroupView
                    group={group}
                    getResult={getResult}
                    settings={transcriptSettings}
                    showThinking={showThinking}
                    subagents={subagents}
                    planContext={planContext}
                  />
                )
              })()}
            </div>
          ))}
        </Profiler>
      </div>
      {/* Headless streaming text - isolated component so token updates don't re-render the virtualizer */}
      <StreamingBlock sessionId={selectedSessionId} />
      {/* Fun verb spinner while session is working */}
      <ThinkingSpinner sessionId={selectedSessionId} />
      {/* Queued messages: rendered inline at the bottom of the transcript */}
      {queuedGroups.length > 0 && (
        <div className="mt-2 border-t border-dashed border-amber-500/30 pt-2">
          <div className="text-[10px] font-mono text-amber-500/60 px-1 mb-1">QUEUED</div>
          {queuedGroups.map((group, i) => (
            <MemoizedGroupView
              key={`queued-${group.timestamp}-${i}`}
              group={group}
              getResult={getResult}
              settings={transcriptSettings}
              showThinking={showThinking}
              subagents={subagents}
            />
          ))}
        </div>
      )}
    </div>
  )
}
