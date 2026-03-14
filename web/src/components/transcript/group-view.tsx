/**
 * GroupView and related components: renders a single display group in the transcript.
 * Includes task notification lines, compaction dividers, and the main group layout.
 */

import { memo, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import type { TranscriptContentBlock } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Markdown } from '../markdown'
import type { DisplayGroup, TaskNotification } from './grouping'
import { MemoizedToolLine } from './tool-line'

function TaskNotificationLine({ notification: n, time }: { notification: TaskNotification; time: string }) {
  const [expanded, setExpanded] = useState(false)
  const isCompleted = n.status === 'completed'

  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
        <span className="text-[10px]">{time}</span>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', isCompleted ? 'bg-emerald-400' : 'bg-red-400')} />
        <span className="truncate flex-1">{n.summary}</span>
        {n.result && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className={cn(
              'w-4 h-4 shrink-0 flex items-center justify-center rounded-full border text-[9px] font-bold transition-colors',
              expanded
                ? 'border-accent text-accent bg-accent/10'
                : 'border-muted-foreground/40 text-muted-foreground/60 hover:border-accent hover:text-accent',
            )}
            title="Show result"
          >
            i
          </button>
        )}
      </div>
      {expanded && n.result && (
        <pre className="text-[10px] font-mono text-foreground/70 mt-1 ml-6 pl-2 border-l border-muted-foreground/20 overflow-x-auto whitespace-pre-wrap">
          {n.result}
        </pre>
      )}
    </div>
  )
}

type SubagentRef = Array<{
  agentId: string
  agentType: string
  description?: string
  status: 'running' | 'stopped'
  startedAt: number
  stoppedAt?: number
  eventCount: number
  tokenUsage?: { totalInput: number; totalOutput: number; cacheCreation: number; cacheRead: number }
}>

export function GroupView({
  group,
  resultMap,
  showThinking = false,
  subagents,
}: {
  group: DisplayGroup
  resultMap: Map<string, { result: string; extra?: Record<string, unknown> }>
  showThinking?: boolean
  subagents?: SubagentRef
}) {
  const expandAll = useSessionsStore(state => state.expandAll)
  const userLabel = useSessionsStore(state => (state.globalSettings.userLabel as string)?.trim() || 'USER')
  const agentLabel = useSessionsStore(state => (state.globalSettings.agentLabel as string)?.trim() || 'CLAUDE')
  const userColor = useSessionsStore(state => (state.globalSettings.userColor as string)?.trim() || '')
  const agentColor = useSessionsStore(state => (state.globalSettings.agentColor as string)?.trim() || '')
  const userSize = useSessionsStore(state => (state.globalSettings.userSize as string) || '')
  const agentSize = useSessionsStore(state => (state.globalSettings.agentSize as string) || '')
  const time = group.timestamp ? new Date(group.timestamp).toLocaleTimeString('en-US', { hour12: false }) : ''

  if (group.type === 'system' && group.notifications?.length) {
    return (
      <div className="mb-2 space-y-1">
        {group.notifications.map((n, i) => (
          <TaskNotificationLine key={i} notification={n} time={time} />
        ))}
      </div>
    )
  }

  const isUser = group.type === 'user'

  type RenderItem =
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tool'; tool: TranscriptContentBlock; result?: string; extra?: Record<string, unknown> }
    | { kind: 'images'; images: Array<{ hash: string; ext: string; url: string; originalPath: string }> }

  const items: RenderItem[] = []

  for (const entry of group.entries) {
    if (entry.images?.length) {
      items.push({ kind: 'images', images: entry.images })
    }

    const content = entry.message?.content
    if (typeof content === 'string') {
      if (content.trim()) items.push({ kind: 'text', text: content })
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const text = typeof block.text === 'string' ? block.text : JSON.stringify(block.text)
          if (text.trim()) items.push({ kind: 'text', text })
        } else if (block.type === 'thinking' && (block.thinking || block.text)) {
          const raw = block.thinking || block.text
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
          if (text.trim()) items.push({ kind: 'thinking', text })
        } else if (block.type === 'tool_use') {
          const id = block.id
          const res = id ? resultMap.get(id) : undefined
          items.push({ kind: 'tool', tool: block, result: res?.result, extra: res?.extra })
        }
      }
    }
  }
  // Detect effort keywords in user messages
  const effortBadge =
    isUser && items.some(it => it.kind === 'text' && /\bultrathink\b/i.test(it.text))
      ? { symbol: '\u25CF', label: 'high' } // ●
      : null

  const label = isUser ? userLabel : agentLabel
  const customColor = isUser ? userColor : agentColor
  const borderColor = isUser ? 'border-event-prompt' : 'border-primary'
  const labelBg = isUser ? 'bg-event-prompt text-background' : 'bg-primary text-primary-foreground'
  const sizeKey = isUser ? userSize : agentSize
  const sizeClass =
    { xs: 'text-[8px]', sm: 'text-[9px]', '': 'text-[10px]', lg: 'text-[13px]', xl: 'text-[16px]' }[sizeKey] ||
    'text-[10px]'

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={cn('text-[10px]', borderColor)}>{'┌──'}</span>
        <span
          className={cn('px-2 py-0.5 font-bold', sizeClass, !customColor && labelBg)}
          style={customColor ? { backgroundColor: customColor, color: '#0a0a0a' } : undefined}
        >
          {label}
        </span>
        {effortBadge && (
          <span className="px-1.5 py-0.5 text-[10px] font-bold bg-orange-400/20 text-orange-400">
            {effortBadge.symbol} {effortBadge.label}
          </span>
        )}
        {group.queued && (
          <span className="px-1.5 py-0.5 text-[10px] font-mono text-amber-400/70 bg-amber-400/10 animate-pulse">
            queued
          </span>
        )}
        <span className="text-muted-foreground text-[10px]">{time}</span>
        <span className={cn('flex-1 text-[10px] overflow-hidden', borderColor)}>{'─'.repeat(40)}</span>
      </div>

      <div className={cn('pl-4 space-y-2', group.queued && 'opacity-50')}>
        {items.map((item, i) => {
          switch (item.kind) {
            case 'thinking':
              if (!showThinking && !expandAll) return null
              return (
                <div key={i} className="border-l-2 border-purple-400/40 pl-3 py-1">
                  <div className="text-[10px] text-purple-400/70 uppercase font-bold tracking-wider mb-1">thinking</div>
                  <div className="text-sm opacity-75">
                    <Markdown>{item.text}</Markdown>
                  </div>
                </div>
              )
            case 'text':
              return (
                <div key={i} className="text-sm">
                  <Markdown>{item.text}</Markdown>
                </div>
              )
            case 'images':
              return (
                <div key={i} className="flex flex-wrap gap-2 pt-2">
                  {item.images.map(img => (
                    <a
                      key={img.hash}
                      href={img.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                      title={img.originalPath}
                    >
                      <img
                        src={img.url}
                        alt={img.originalPath.split('/').pop() || 'image'}
                        className="max-w-xs max-h-48 rounded border border-border hover:border-primary transition-colors"
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              )
            case 'tool':
              return (
                <MemoizedToolLine
                  key={i}
                  tool={item.tool}
                  result={item.result}
                  toolUseResult={item.extra}
                  subagents={subagents}
                />
              )
          }
        })}
      </div>
    </div>
  )
}

// Construction-striped "COMPACTED" divider line
export function CompactedDivider() {
  return (
    <div className="my-4 flex items-center gap-2">
      <div
        className="flex-1 h-px"
        style={{
          backgroundImage:
            'repeating-linear-gradient(90deg, #e5c07b 0px, #e5c07b 8px, transparent 8px, transparent 16px)',
        }}
      />
      <span className="px-2 py-0.5 text-[10px] font-bold font-mono uppercase tracking-widest text-amber-400/80 bg-amber-400/10 border border-amber-400/30">
        compacted
      </span>
      <div
        className="flex-1 h-px"
        style={{
          backgroundImage:
            'repeating-linear-gradient(90deg, #e5c07b 0px, #e5c07b 8px, transparent 8px, transparent 16px)',
        }}
      />
    </div>
  )
}

// Compacting in-progress banner
export function CompactingBanner() {
  return (
    <div className="my-4 flex items-center gap-2 px-3 py-2 bg-amber-400/10 border border-amber-400/30 animate-pulse">
      <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      <span className="text-[11px] font-mono font-bold text-amber-400 uppercase tracking-wider">
        Compacting context...
      </span>
    </div>
  )
}

// Memoized GroupView - prevents re-renders when parent (virtualizer) re-renders
// but the group data hasn't actually changed
export const MemoizedGroupView = memo(GroupView)
