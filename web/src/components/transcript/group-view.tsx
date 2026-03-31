/**
 * GroupView and related components: renders a single display group in the transcript.
 * Includes task notification lines, compaction dividers, and the main group layout.
 */

import { memo, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import type { TranscriptContentBlock, TranscriptImage, TranscriptToolUseResult } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'

// Chat bubble color presets - keys match dashboardPrefs.chatBubbleColor
const BUBBLE_COLORS: Record<string, string> = {
  blue: 'bg-[#2563eb]/90',
  teal: 'bg-teal-600/90',
  purple: 'bg-purple-600/90',
  green: 'bg-emerald-600/90',
  orange: 'bg-amber-600/90',
  pink: 'bg-pink-600/90',
  indigo: 'bg-indigo-600/90',
}

// Exported for settings color picker
export const BUBBLE_COLOR_OPTIONS = Object.keys(BUBBLE_COLORS)

// Transcript entries are augmented by the concentrator API with rendering data
// (images extracted from base64, structured tool use results) before being sent
// to the dashboard. This extends the base entry type for rendering purposes.
interface RenderableTranscriptEntry {
  message?: { role?: string; content?: string | TranscriptContentBlock[] }
  images?: TranscriptImage[]
  toolUseResult?: TranscriptToolUseResult
}

import { CopyMenu } from '../copy-menu'
import { Markdown } from '../markdown'
import { AgentTranscriptInline } from './agent-views'
import type { DisplayGroup, TaskNotification } from './grouping'
import { MemoizedToolLine } from './tool-line'
import { BashOutput } from './tool-renderers'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s % 60)}s`
}

function TaskNotificationLine({ notification: n, time }: { notification: TaskNotification; time: string }) {
  const [expanded, setExpanded] = useState(false)
  const statusColor =
    n.status === 'completed' ? 'bg-emerald-400' : n.status === 'killed' ? 'bg-amber-400' : 'bg-red-400'

  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
        <span className="text-[10px]">{time}</span>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', statusColor)} />
        <span className="truncate flex-1">{n.summary}</span>
        {n.usage && (
          <span className="text-[9px] text-muted-foreground/60 shrink-0">
            {Math.round(n.usage.totalTokens / 1000)}K tok
            {' / '}
            {n.usage.toolUses} tools
            {' / '}
            {formatDuration(n.usage.durationMs)}
          </span>
        )}
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
        <pre className="text-[10px] font-mono text-foreground/70 mt-1 ml-6 pl-2 border-l border-muted-foreground/20 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
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
  planContext,
}: {
  group: DisplayGroup
  resultMap: Map<string, { result: string; extra?: Record<string, unknown> }>
  showThinking?: boolean
  subagents?: SubagentRef
  planContext?: { content: string; path?: string }
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
    | { kind: 'bash'; text: string }
    | { kind: 'channel'; text: string; source: string; sessionId?: string; intent?: string; isInterSession?: boolean }
    | { kind: 'images'; images: Array<{ hash: string; ext: string; url: string; originalPath: string }> }

  const items: RenderItem[] = []

  for (const rawEntry of group.entries) {
    const entry = rawEntry as RenderableTranscriptEntry
    if (entry.images?.length) {
      items.push({ kind: 'images', images: entry.images })
    }

    const content = entry.message?.content
    if (typeof content === 'string') {
      if (content.trim()) {
        const hasBashTags = /<bash-(input|stdout|stderr)>/.test(content)
        const channelMatch = content.match(/^<channel\s+([^>]*)>\n?([\s\S]*?)\n?<\/channel>$/)
        if (channelMatch) {
          const attrs = channelMatch[1]
          const msg = channelMatch[2].trim()
          const getAttr = (name: string) => {
            const m = attrs.match(new RegExp(`${name}="([^"]*)"`))
            return m?.[1]
          }
          const source = getAttr('source') || 'unknown'
          const sender = getAttr('sender')
          const fromProject = getAttr('from_project')
          const intent = getAttr('intent')

          if (sender === 'session' && fromProject) {
            // Inter-session message -- rich display
            const fromSessionId = getAttr('from_session')
            items.push({
              kind: 'channel',
              text: msg,
              source: fromProject,
              sessionId: fromSessionId,
              intent: intent || undefined,
              isInterSession: true,
            })
          } else if (source === 'rclaude') {
            // Our own dashboard input -- strip wrapper, show as text
            items.push({ kind: 'text', text: msg })
          } else {
            // External channel (telegram, discord, etc.)
            items.push({ kind: 'channel', text: msg, source })
          }
        } else if (hasBashTags) {
          // Merge consecutive bash items (input entry + stdout/stderr entry)
          const prev = items[items.length - 1]
          if (prev?.kind === 'bash') {
            prev.text += content
          } else {
            items.push({ kind: 'bash', text: content })
          }
        } else {
          items.push({ kind: 'text', text: content })
        }
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const text = typeof block.text === 'string' ? block.text : JSON.stringify(block.text)
          if (text.trim()) {
            const hasBashTags = /<bash-(input|stdout|stderr)>/.test(text)
            items.push(hasBashTags ? { kind: 'bash', text } : { kind: 'text', text })
          }
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

  // Detect channel origin from entry metadata
  const channelOrigin = isUser
    ? ((group.entries.find(e => (e as unknown as Record<string, unknown>).origin) as unknown as Record<string, unknown>)
        ?.origin as { kind: string; server: string } | undefined)
    : undefined
  const channelServer = channelOrigin?.kind === 'channel' ? channelOrigin.server : undefined

  const label = isUser ? userLabel : agentLabel
  const customColor = isUser ? userColor : agentColor
  const borderColor = isUser ? 'border-event-prompt' : 'border-primary'
  const labelBg = isUser ? 'bg-event-prompt text-background' : 'bg-primary text-primary-foreground'
  const sizeKey = isUser ? userSize : agentSize
  const sizeClass =
    { xs: 'text-[8px]', sm: 'text-[9px]', '': 'text-[10px]', lg: 'text-[13px]', xl: 'text-[16px]' }[sizeKey] ||
    'text-[10px]'
  const chatBubbles = useSessionsStore(s => s.dashboardPrefs.chatBubbles)
  const bubbleColor = useSessionsStore(s => s.dashboardPrefs.chatBubbleColor) || 'blue'

  // Chat bubble layout for user messages (opt-in)
  // Skip bubbles for inter-session messages - they use the teal card renderer instead
  const hasInterSessionContent = items.some(it => it.kind === 'channel' && it.isInterSession)
  if (chatBubbles && isUser && !hasInterSessionContent) {
    const bubbleBg = BUBBLE_COLORS[bubbleColor] || BUBBLE_COLORS.blue
    return (
      <div className="mb-3 flex justify-end">
        <div className={cn('max-w-[85%] sm:max-w-[75%]', group.queued && 'opacity-50')}>
          <div className={cn('rounded-2xl rounded-br-sm px-4 py-2.5 text-white', bubbleBg, sizeClass)}>
            {items.map((item, i) => {
              if (item.kind === 'text') {
                return (
                  <div
                    key={i}
                    className="text-sm [&_a]:text-blue-200 [&_a]:underline [&_code]:bg-white/15 [&_code]:px-1 [&_code]:rounded"
                  >
                    <Markdown inline>{item.text}</Markdown>
                  </div>
                )
              }
              if (item.kind === 'images') {
                return (
                  <div key={i} className="flex gap-1 flex-wrap mt-1">
                    {item.images.map(img => (
                      <img key={img.hash} src={img.url} alt="" className="max-h-24 rounded" />
                    ))}
                  </div>
                )
              }
              return null
            })}
          </div>
          <div className="flex items-center justify-end gap-1.5 mt-0.5 px-1">
            <span className="text-muted-foreground/50 text-[9px]">{time}</span>
            {channelServer === 'rclaude' && <span className="text-teal-400/40 text-[9px]">channel</span>}
            {effortBadge && <span className="text-orange-400/60 text-[9px]">{effortBadge.symbol}</span>}
          </div>
        </div>
      </div>
    )
  }

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
        {channelServer &&
          (channelServer === 'rclaude' ? (
            <span className="text-[9px] text-teal-400/50 font-mono">via channel</span>
          ) : (
            <span className="px-1.5 py-0.5 text-[10px] font-bold bg-teal-400/20 text-teal-400 border border-teal-400/50 animate-pulse">
              CHANNEL: {channelServer}
            </span>
          ))}
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
            case 'text': {
              const isApiError = /^API Error:\s*\d+\s*\{/.test(item.text)
              return isApiError ? (
                <div
                  key={i}
                  className="text-sm px-3 py-2 bg-destructive/15 border border-destructive/40 rounded font-mono"
                >
                  <div className="text-destructive font-bold text-xs uppercase mb-1">API Error</div>
                  <pre className="text-[11px] text-destructive/80 whitespace-pre-wrap break-all">{item.text}</pre>
                </div>
              ) : (
                <div key={i} className="text-sm group/text relative">
                  <Markdown>{item.text}</Markdown>
                  <CopyMenu
                    text={item.text}
                    copyAsImage
                    className="absolute top-0 right-0 opacity-60 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/text:opacity-60 hover:!opacity-100 transition-opacity"
                  />
                </div>
              )
            }
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
            case 'channel':
              if (item.isInterSession) {
                const intentStyles: Record<string, string> = {
                  request: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
                  response: 'bg-green-400/15 text-green-400 border-green-400/30',
                  notify: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
                  progress: 'bg-zinc-400/15 text-zinc-400 border-zinc-400/30',
                }
                const iStyle = intentStyles[item.intent || ''] || intentStyles.notify
                return (
                  <div key={i} className="rounded-lg border border-teal-500/30 bg-teal-500/5 px-3 py-2.5 my-1">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10px] font-mono text-teal-400/60">from</span>
                      <button
                        type="button"
                        className="text-xs font-bold text-teal-400 hover:text-teal-300 hover:underline"
                        onClick={() => {
                          // Find and select the sender session
                          if (item.sessionId) {
                            const store = useSessionsStore.getState()
                            const target = store.sessions.find(s => s.id === item.sessionId)
                            if (target) {
                              haptic('tap')
                              store.selectSession(item.sessionId)
                            }
                          }
                        }}
                      >
                        {item.source}
                      </button>
                      {item.intent && (
                        <span
                          className={cn(
                            'px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider border rounded',
                            iStyle,
                          )}
                        >
                          {item.intent}
                        </span>
                      )}
                    </div>
                    <div className="text-sm">
                      <Markdown>{item.text}</Markdown>
                    </div>
                  </div>
                )
              }
              return (
                <div key={i} className="text-sm border-l-2 border-teal-400/40 pl-3 py-1">
                  <div className="text-[10px] text-teal-400/70 uppercase font-bold tracking-wider mb-1">
                    channel: {item.source}
                  </div>
                  <Markdown>{item.text}</Markdown>
                </div>
              )
            case 'bash':
              return (
                <div key={i} className="text-sm">
                  <BashOutput result={item.text} />
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
                  renderAgentInline={(agentId, toolId) => <AgentTranscriptInline agentId={agentId} toolId={toolId} />}
                  {...(item.tool.name === 'ExitPlanMode' && planContext
                    ? { planContent: planContext.content, planPath: planContext.path }
                    : {})}
                />
              )
            default:
              return null
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
