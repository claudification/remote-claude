/**
 * TranscriptView - Virtualized transcript renderer.
 * Uses @tanstack/react-virtual for efficient rendering of large transcript streams.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Fragment,
  memo,
  Profiler,
  type ProfilerOnRenderCallback,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { record } from '@/lib/perf-metrics'
import type { TranscriptEntry } from '@/lib/types'
import { LinkRequestBanners, PermissionBanners } from '../conversation-detail/conversation-banners'
import { Markdown } from '../markdown'
import { CompactedDivider, CompactingBanner, MemoizedGroupView, SkillDivider } from './group-view'
import { type DisplayGroup, useIncrementalGroups } from './grouping'

/** Content-aware size estimation to minimize layout shift on first render.
 *  Falls back to measuredSizes cache for groups that have been rendered before. */
function estimateGroupSize(group: DisplayGroup, measuredSizes: Map<string, number>, key: string): number {
  const cached = measuredSizes.get(key)
  if (cached !== undefined) return cached

  switch (group.type) {
    case 'compacted':
      return 40
    case 'compacting':
      return 56
    case 'skill':
      return 44
    case 'system':
      return group.notifications ? 56 : 48
    case 'boot':
      // ~22px per step, plus a small header + padding. Clamp so a very long
      // boot timeline doesn't eat the whole viewport.
      return Math.min(48 + group.entries.length * 22, 400)
    case 'launch':
      return Math.min(48 + group.entries.length * 22, 400)
    case 'user': {
      const entries = group.entries
      let textLen = 0
      for (const entry of entries) {
        const content = (entry as Record<string, unknown>).message as
          | { content?: string | Array<{ type: string; text?: string }> }
          | undefined
        if (typeof content?.content === 'string') textLen += content.content.length
        else if (Array.isArray(content?.content)) {
          for (const b of content.content) {
            if (b.type === 'text' && b.text) textLen += b.text.length
          }
        }
      }
      // Header ~40px + ~20px per 80-char line, clamped
      return Math.max(56, Math.min(40 + Math.ceil(textLen / 80) * 20, 400))
    }
    case 'assistant': {
      let toolCount = 0
      let textLen = 0
      for (const entry of group.entries) {
        const content = (entry as Record<string, unknown>).message as
          | { content?: string | Array<{ type: string; text?: string }> }
          | undefined
        if (!Array.isArray(content?.content)) continue
        for (const b of content.content) {
          if (b.type === 'tool_use') toolCount++
          if (b.type === 'text' && b.text) textLen += b.text.length
        }
      }
      // Base + collapsed tool lines (~52px each) + text lines
      const base = 48
      const toolHeight = toolCount * 52
      const textHeight = Math.ceil(textLen / 80) * 20
      return Math.max(80, Math.min(base + toolHeight + textHeight, 1500))
    }
    default:
      return 120
  }
}

const EMPTY_STREAMING = ''

/** Isolated streaming text component - subscribes to its own store slice so token updates don't re-render the virtualizer */
const StreamingBlock = memo(function StreamingBlock({ conversationId }: { conversationId: string | null }) {
  const showStreaming = useConversationsStore(state => state.controlPanelPrefs.showStreaming !== false)
  const streamingText = useConversationsStore(
    state => (conversationId ? state.streamingText[conversationId] : null) || EMPTY_STREAMING,
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

/** Shows a fun random verb spinner while the conversation is active (between UserPromptSubmit and Stop) */
const ThinkingSpinner = memo(function ThinkingSpinner({ conversationId }: { conversationId: string | null }) {
  const isActive = useConversationsStore(state =>
    conversationId ? state.sessionsById[conversationId]?.status === 'active' : false,
  )
  const totalOutput = useConversationsStore(state =>
    conversationId ? (state.sessionsById[conversationId]?.stats?.totalOutputTokens ?? 0) : 0,
  )
  // Custom verbs: project settings override > session verbs (from CC settings) > defaults
  const customVerbs = useConversationsStore(state => {
    const session = conversationId ? state.sessionsById[conversationId] : undefined
    const projectVerbs = session?.project ? state.projectSettings[session.project]?.verbs : undefined
    return projectVerbs?.length ? projectVerbs : session?.spinnerVerbs
  })
  const verbList = customVerbs?.length ? customVerbs : VERBS

  const [verb, setVerb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)])
  const [dots, setDots] = useState(0)
  const baselineRef = useRef(0)

  // Capture baseline when turn starts
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalOutput intentionally omitted - only capture baseline on status transition, not every token update
  useEffect(() => {
    if (isActive) baselineRef.current = totalOutput
  }, [isActive]) // only on status transition, not on every token update

  const turnTokens = isActive ? Math.max(0, totalOutput - baselineRef.current) : 0

  // biome-ignore lint/correctness/useExhaustiveDependencies: verbList intentionally omitted - stable for session duration, re-registering interval on every render unnecessary
  useEffect(() => {
    if (!isActive) return
    const verbInterval = setInterval(() => {
      setVerb(verbList[Math.floor(Math.random() * verbList.length)])
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
    <div className="mt-2 flex flex-col items-start px-4 py-1.5 text-[11px] font-mono text-muted-foreground/60">
      <div className="flex items-center gap-2">
        <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
        <span className="text-accent/70">
          {verb}
          {'.'.repeat(dots)}
        </span>
      </div>
      {turnTokens > 0 && (
        <span className="text-muted-foreground/40 tabular-nums pl-4 text-[10px]">
          {(turnTokens / 1000).toFixed(1)}K tokens
        </span>
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

/** Profiler wraps its children in an extra fiber and runs React's measurement code
 *  on every commit -- meaningful overhead if left on for every user. Only enable it
 *  when the perf monitor is toggled on (controlPanelPrefs.showPerfMonitor). */
function MaybeProfiler({ enabled, id, children }: { enabled: boolean; id: string; children: ReactNode }) {
  if (!enabled) return <Fragment>{children}</Fragment>
  return (
    <Profiler id={id} onRender={onRenderProfile}>
      {children}
    </Profiler>
  )
}

interface TranscriptViewProps {
  entries: TranscriptEntry[]
  follow?: boolean
  showThinking?: boolean
  onUserScroll?: () => void
  onReachedBottom?: () => void
}

export const TranscriptView = memo(function TranscriptView({
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
  const expandAll = useConversationsStore(state => state.expandAll)
  const globalSettings = useConversationsStore(state => state.globalSettings)
  const chatBubbles = useConversationsStore(state => state.controlPanelPrefs.chatBubbles)
  const bubbleColor = useConversationsStore(state => state.controlPanelPrefs.chatBubbleColor) || 'blue'
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
  const subagentsSummary = useConversationsStore(state => {
    const session = state.selectedConversationId ? state.sessionsById[state.selectedConversationId] : undefined
    if (!session?.subagents?.length) return ''
    return session.subagents.map(a => `${a.agentId}:${a.status}:${a.description || ''}`).join('|')
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: subagentsSummary is a serialized primitive dep key that triggers recompute when subagent state changes
  const subagents = useMemo(() => {
    const state = useConversationsStore.getState()
    return state.selectedConversationId ? state.sessionsById[state.selectedConversationId]?.subagents : undefined
  }, [subagentsSummary])

  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const perfEnabled = useConversationsStore(state => state.controlPanelPrefs.showPerfMonitor)

  // Count pending permissions for the selected session. Used as a scroll-to-bottom
  // trigger so a newly-arrived permission pins into view when follow is active.
  const pendingPermissionCount = useConversationsStore(state =>
    state.selectedConversationId
      ? state.pendingPermissions.filter(p => p.conversationId === state.selectedConversationId).length
      : 0,
  )

  // Same idea for pending project-link requests targeting this conversation -- they
  // also render inline at the transcript bottom as a blocking gate.
  const pendingLinkCount = useConversationsStore(state =>
    state.selectedConversationId
      ? state.pendingProjectLinks.filter(r => r.toSession === state.selectedConversationId).length
      : 0,
  )

  // Cache measured sizes so estimateSize can use real heights for groups
  // that have been rendered before (survives virtualizer cache invalidation)
  const measuredSizesRef = useRef(new Map<string, number>())

  const getItemKey = useCallback(
    (index: number) => {
      const g = mainGroups[index]
      return `${g.type}-${g.timestamp}-${index}`
    },
    [mainGroups],
  )

  const virtualizer = useVirtualizer({
    count: mainGroups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: index => estimateGroupSize(mainGroups[index], measuredSizesRef.current, getItemKey(index)),
    overscan: 5,
    getItemKey,
    // Safari fix: ResizeObserver can fire mid-layout before paint completes,
    // causing the virtualizer to read intermediate/partial element heights and
    // clip content. Deferring to rAF ensures measurements happen after layout.
    useAnimationFrameWithResizeObserver: true,
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

  // Track measured sizes: visible items have real DOM measurements from ResizeObserver.
  // Cache these so estimateSize returns accurate heights when items re-enter the viewport.
  const virtualItems = virtualizer.getVirtualItems()
  for (const item of virtualItems) {
    measuredSizesRef.current.set(String(item.key), item.size)
  }

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

  // Scroll to bottom: use virtualizer.scrollToIndex first (measurement-aware),
  // then a short settle pass for dynamic heights that expand after render.
  const scrollToBottom = useCallback(() => {
    if (followKilledRef.current) return
    const count = mainGroups.length
    if (count > 0) {
      virtualizer.scrollToIndex(count - 1, { align: 'end' })
    }
    const el = parentRef.current
    if (!el) return
    // Two-frame settle: items may measure larger than estimated after first paint
    let lastHeight = -1
    let retries = 0
    function settle() {
      if (!el || followKilledRef.current) return
      if (el.scrollHeight !== lastHeight && retries < 3) {
        lastHeight = el.scrollHeight
        el.scrollTop = el.scrollHeight
        retries++
        requestAnimationFrame(settle)
      }
    }
    requestAnimationFrame(settle)
  }, [mainGroups.length, virtualizer])

  // Subscribe to selected session's transcript changes for scroll-to-bottom.
  // IMPORTANT: track the transcript array REFERENCE for the selected session, not the global
  // newDataSeq counter. newDataSeq increments for ANY session's data (events, transcripts),
  // which caused scrollToBottom -> virtualizer.scrollToIndex -> TranscriptView re-render on
  // every store update from any conversation. By comparing the specific transcript reference,
  // we only scroll when the viewed session's data actually changes.
  const followRef = useRef(follow)
  followRef.current = follow
  useEffect(() => {
    const getTranscriptRef = (state: {
      selectedConversationId: string | null
      transcripts: Record<string, unknown>
    }) => (state.selectedConversationId ? state.transcripts[state.selectedConversationId] : undefined)
    let lastRef = getTranscriptRef(useConversationsStore.getState())

    return useConversationsStore.subscribe(state => {
      const current = getTranscriptRef(state)
      if (current !== lastRef) {
        lastRef = current
        if (followRef.current && !followKilledRef.current) scrollToBottom()
      }
    })
  }, [scrollToBottom])

  // Scroll to bottom on initial mount, follow toggle, and entry count changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: entries.length is used as a dep key to trigger scroll on new entries, not to access entries directly
  useEffect(() => {
    if (!follow) return
    // Delay slightly to allow virtualizer to process new items and measure
    const timer = setTimeout(scrollToBottom, 50)
    return () => clearTimeout(timer)
  }, [follow, entries.length, scrollToBottom])

  // Also scroll to bottom when a new pending permission arrives -- permissions
  // render after the virtualized content as a blocking UI gate, so the user
  // needs to see them immediately when follow is active.
  useEffect(() => {
    if (!follow) return
    if (pendingPermissionCount === 0) return
    const timer = setTimeout(scrollToBottom, 50)
    return () => clearTimeout(timer)
  }, [follow, pendingPermissionCount, scrollToBottom])

  // Same for link requests -- when another session asks to link, pin the
  // inline approve/block card into view if follow is active.
  useEffect(() => {
    if (!follow) return
    if (pendingLinkCount === 0) return
    const timer = setTimeout(scrollToBottom, 50)
    return () => clearTimeout(timer)
  }, [follow, pendingLinkCount, scrollToBottom])

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
      className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4"
      style={{ overscrollBehavior: 'contain', touchAction: 'pan-y' }}
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
        <MaybeProfiler enabled={perfEnabled} id="TranscriptGroups">
          {(() => {
            lastVirtualItemCount = virtualItems.length
            lastTotalGroupCount = mainGroups.length
            return virtualItems
          })().map(virtualItem => (
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
        </MaybeProfiler>
      </div>
      {/* Streaming/queued region: wrapped in its own Profiler so perf reports
          attribute stream-delta re-renders correctly (they used to fall outside
          TranscriptGroups and silently cost frames). */}
      <MaybeProfiler enabled={perfEnabled} id="TranscriptStreaming">
        {/* Headless streaming text - isolated component so token updates don't re-render the virtualizer */}
        <StreamingBlock conversationId={selectedConversationId} />
        {/* Fun verb spinner while session is working */}
        <ThinkingSpinner conversationId={selectedConversationId} />
        {/* Pending permission + link requests: rendered inline at the bottom as
            blocking UI gates. Both follow the same pattern -- structured wire
            message -> store -> inline banner -> user response over WS. */}
        <div className="mt-2">
          <LinkRequestBanners />
          <PermissionBanners />
        </div>
        {/* Queued messages: rendered inline at the bottom of the transcript */}
        {queuedGroups.length > 0 && (
          <div className="mt-2 border-t border-dashed border-amber-500/30 pt-2">
            <div className="text-[10px] font-mono text-amber-500/60 px-1 mb-1">QUEUED</div>
            {queuedGroups.map((group, i) => (
              <MemoizedGroupView
                // biome-ignore lint/suspicious/noArrayIndexKey: queued groups may share timestamp, index disambiguates
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
      </MaybeProfiler>
    </div>
  )
})
