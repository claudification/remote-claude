/**
 * GroupView and related components: renders a single display group in the transcript.
 * Includes task notification lines, compaction dividers, and the main group layout.
 */

import { memo, useState } from 'react'
import type { TranscriptContentBlock, TranscriptImage, TranscriptToolUseResult } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'

// Chat bubble color presets - keys match controlPanelPrefs.chatBubbleColor
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

// Transcript entries are augmented by the broker API with rendering data
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
import { BootTimeline } from './boot-timeline'
import { ConversationTag } from './conversation-tag'
import type { DisplayGroup, TaskNotification } from './grouping'
import { LaunchTimeline } from './launch-timeline'
import { MemoizedToolLine } from './tool-line'
import { BashOutput } from './tool-renderers'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s % 60)}s`
}

/** Render system messages (slash commands, api retries, informational, state changes, etc.) */
function SystemLine({ group, time }: { group: DisplayGroup; time: string }) {
  const entry = group.entries[0] as Record<string, unknown>
  const sub = group.systemSubtype || ''
  const content = (entry.content as string) || ''

  let text = ''
  let color = 'text-muted-foreground'

  switch (sub) {
    case 'local_command': {
      // Strip CC's internal XML markup from command output
      const stripped = content
        .replace(/<\/?(?:local-command-stdout|command-name|command-message|command-args|local-command-caveat)>/g, '')
        .trim()
      text = stripped
      if (stripped.startsWith('Unknown skill') || stripped.startsWith('Error') || stripped.startsWith('Failed'))
        color = 'text-red-400'
      // Rename output gets a subtle style
      if (stripped.startsWith('Session renamed to:')) color = 'text-cyan-400/70'
      break
    }
    case 'api_retry':
      text = `API retry ${entry.attempt}/${entry.max_retries} (${entry.error_status || 'timeout'}) - retrying in ${Math.ceil((entry.retry_delay_ms as number) / 1000)}s`
      color = 'text-amber-400'
      break
    case 'informational':
      text = content
      color = 'text-cyan-400/70'
      break
    case 'compact_boundary':
      text = 'Context compacted'
      color = 'text-purple-400/70'
      break
    case 'session_state_changed':
      text = `Session: ${entry.state}`
      color = 'text-muted-foreground/70'
      break
    case 'task_notification': {
      const status = entry.status as string
      const summary = entry.summary as string
      text = `Task ${status}${summary ? `: ${summary}` : ''}`
      color = status === 'completed' ? 'text-emerald-400' : status === 'failed' ? 'text-red-400' : 'text-amber-400'
      break
    }
    case 'task_progress': {
      const desc = (entry.description as string) || ''
      const tokens = (entry.usage as Record<string, unknown>)?.total_tokens
      text = `${desc}${tokens ? ` (${tokens} tokens)` : ''}`
      color = 'text-muted-foreground/70'
      break
    }
    case 'turn_duration': {
      const dMs = (entry.durationMs as number) || (entry.duration_ms as number) || 0
      const dApiMs = (entry.durationApiMs as number) || (entry.duration_api_ms as number)
      const msgCount = entry.messageCount as number
      text = dMs
        ? `Turn: ${formatDuration(dMs / 1000)}${dApiMs ? ` (API: ${formatDuration(dApiMs / 1000)})` : ''}${msgCount ? ` -- ${msgCount} messages` : ''}`
        : 'Turn ended'
      color = 'text-muted-foreground/50'
      break
    }
    case 'memory_saved':
      text = 'Memory saved'
      color = 'text-cyan-400/70'
      break
    case 'agents_killed':
      text = 'Background agents stopped'
      color = 'text-red-400/70'
      break
    case 'permission_retry':
      text = `Allowed: ${(entry.commands as string[])?.join(', ') || content}`
      color = 'text-green-400/70'
      break
    case 'stop_hook_summary': {
      const reason = (entry.stopReason as string) || (entry.stop_reason as string) || 'end_turn'
      const numTurns = (entry.numTurns as number) || (entry.num_turns as number)
      const parts = [`Stop: ${reason}`]
      if (numTurns) parts.push(`${numTurns} turns`)
      text = parts.join(' -- ')
      color = 'text-muted-foreground/50'
      break
    }
    case 'scheduled_task_fire':
      text = content
        ? `Scheduled: ${content.length > 80 ? `${content.slice(0, 80)}...` : content}`
        : 'Scheduled task fired'
      color = 'text-amber-400/70'
      break
    case 'away_summary':
      return (
        <div className="my-3 mx-auto max-w-[95%]">
          <div className="border border-zinc-600/40 bg-zinc-800/30 rounded px-4 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[9px] font-bold font-mono uppercase tracking-widest text-zinc-400/70">recap</span>
              <span className="flex-1 h-px bg-zinc-600/30" />
              <span className="text-muted-foreground/40 text-[10px]">{time}</span>
              <JsonInspector title="away_summary" data={entry as Record<string, unknown>} />
            </div>
            <div className="text-[11px] text-zinc-300/80 leading-relaxed">{content}</div>
          </div>
        </div>
      )
    default:
      text = content || `[${sub}]`
      break
  }

  if (!text) return null

  return (
    <div className="mb-1 flex items-center justify-center gap-2 text-[10px]">
      <span className={color}>{text}</span>
      <span className="text-muted-foreground/40">{time}</span>
      <JsonInspector title={sub || 'system'} data={entry as Record<string, unknown>} />
    </div>
  )
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

interface TranscriptSettings {
  expandAll: boolean
  userLabel: string
  agentLabel: string
  userColor: string
  agentColor: string
  userSize: string
  agentSize: string
  chatBubbles: boolean
  bubbleColor: string
}

type ResultLookup = (id: string) => { result: string; extra?: Record<string, unknown>; isError?: boolean } | undefined

export function GroupView({
  group,
  getResult,
  settings,
  showThinking = false,
  subagents,
  planContext,
}: {
  group: DisplayGroup
  getResult: ResultLookup
  settings: TranscriptSettings
  showThinking?: boolean
  subagents?: SubagentRef
  planContext?: { content: string; path?: string }
}) {
  const { expandAll, userLabel, agentLabel, userColor, agentColor, userSize, agentSize } = settings
  const time = group.timestamp ? new Date(group.timestamp).toLocaleTimeString('en-US', { hour12: false }) : ''

  if (group.type === 'boot') {
    return <BootTimeline group={group} />
  }

  if (group.type === 'launch') {
    return <LaunchTimeline group={group} />
  }

  if (group.type === 'system' && group.notifications?.length) {
    return (
      <div className="mb-2 space-y-1">
        {group.notifications.map((n, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: notifications are ordered display items, no stable IDs
          <TaskNotificationLine key={i} notification={n} time={time} />
        ))}
      </div>
    )
  }

  if (group.type === 'system' && group.systemSubtype) {
    return <SystemLine group={group} time={time} />
  }

  const isUser = group.type === 'user'

  // Parse <project-task id="..." title="..." ...>body</project-task> from user input
  const projectTaskRe = /^<project-task\s+([^>]*)>([\s\S]*?)<\/project-task>$/
  function parseProjectTask(text: string): RenderItem | null {
    const m = text.trim().match(projectTaskRe)
    if (!m) return null
    const attrs = m[1]
    const body = m[2].trim()
    const attr = (name: string) => {
      const a = attrs.match(new RegExp(`${name}="([^"]*?)"`))
      return a?.[1]
    }
    const id = attr('id') || ''
    const title = attr('title')?.replace(/&quot;/g, '"') || id
    const priority = attr('priority')
    const taskStatus = attr('status')
    const tagsStr = attr('tags')
    const tags = tagsStr ? tagsStr.split(',').filter(Boolean) : undefined
    // Strip the LLM instruction suffix (everything after the last blank line before </project-task>)
    const cleanBody = body.replace(/\n\nSet status to .*$/s, '').trim()
    return { kind: 'project-task', id, title, body: cleanBody, priority, taskStatus, tags }
  }

  type RenderItem =
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string; encryptedBytes?: number; rawBlock?: TranscriptContentBlock }
    | {
        kind: 'project-task'
        id: string
        title: string
        body: string
        priority?: string
        taskStatus?: string
        tags?: string[]
      }
    | {
        kind: 'tool'
        tool: TranscriptContentBlock
        result?: string
        extra?: Record<string, unknown>
        isError?: boolean
      }
    | { kind: 'bash'; text: string }
    | {
        kind: 'channel'
        text: string
        source: string
        sessionId?: string
        intent?: string
        isInterConversation?: boolean
        isDialog?: boolean
        dialogStatus?: string
        dialogAction?: string
        isSystem?: boolean
        systemKind?: string
      }
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
              isInterConversation: true,
            })
          } else if (sender === 'dialog') {
            // Dialog result -- structured display
            const status = getAttr('status') || 'submitted'
            const action = getAttr('action')
            items.push({
              kind: 'channel',
              text: msg,
              source: 'dialog',
              isDialog: true,
              dialogStatus: status,
              dialogAction: action || undefined,
            })
          } else if (source === 'rclaude' && sender === 'system') {
            // System events (spawn_result, channel disconnects, etc.) -- NOT user input.
            // Carry whichever discriminating attr is present so the renderer can label it.
            const systemKind = getAttr('spawn_result') || getAttr('event') || getAttr('kind') || undefined
            items.push({ kind: 'channel', text: msg, source: 'system', isSystem: true, systemKind })
          } else if (source === 'rclaude') {
            // Our own dashboard input -- strip wrapper, check for project-task tag
            const pt = parseProjectTask(msg)
            items.push(pt || { kind: 'text', text: msg })
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
          const pt = parseProjectTask(content)
          items.push(pt || { kind: 'text', text: content })
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
        } else if (block.type === 'thinking') {
          const raw = block.thinking || block.text
          const text = typeof raw === 'string' ? raw : typeof raw === 'undefined' ? '' : JSON.stringify(raw)
          if (text.trim()) {
            items.push({ kind: 'thinking', text })
          } else if (block.signature) {
            // Claude 4.7+ encrypted thinking: the plaintext field is empty,
            // the signature blob carries the reasoning (AES-GCM, Anthropic key).
            // Show a placeholder so the user knows the model reasoned here,
            // with (i) to inspect the raw block.
            items.push({ kind: 'thinking', text: '', encryptedBytes: block.signature.length, rawBlock: block })
          }
        } else if (block.type === 'tool_use') {
          const id = block.id
          const res = id ? getResult(id) : undefined
          items.push({ kind: 'tool', tool: block, result: res?.result, extra: res?.extra, isError: res?.isError })
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
  const { chatBubbles, bubbleColor } = settings

  // Chat bubble layout for user messages (opt-in)
  // Skip bubbles for inter-conversation messages and project-task cards - they use rich card renderers
  const hasInterSessionContent = items.some(
    it => it.kind === 'channel' && (it.isInterConversation || it.isDialog || it.isSystem),
  )
  const hasProjectTask = items.some(it => it.kind === 'project-task')
  if (chatBubbles && isUser && !hasInterSessionContent && !hasProjectTask) {
    const bubbleBg = BUBBLE_COLORS[bubbleColor] || BUBBLE_COLORS.blue
    return (
      <div className="mb-3 flex justify-end">
        <div className={cn('max-w-[85%] sm:max-w-[75%]', group.queued && 'opacity-50')}>
          <div className={cn('rounded-2xl rounded-br-sm px-4 py-2.5 text-white', bubbleBg, sizeClass)}>
            {items.map((item, i) => {
              if (item.kind === 'text') {
                // Use full markdown when text contains block-level elements (code fences, tables, etc.)
                const hasBlocks = /^```/m.test(item.text) || /^\|.*\|.*\|/m.test(item.text)
                return (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                    key={i}
                    className="text-sm [&_a]:text-blue-200 [&_a]:underline [&_code]:!bg-black/25 [&_code]:!px-1.5 [&_code]:!py-0.5 [&_code]:!rounded-sm [&_code]:!text-white/80 [&_code]:!text-[0.85em]"
                  >
                    <Markdown inline={!hasBlocks}>{item.text}</Markdown>
                  </div>
                )
              }
              if (item.kind === 'images') {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
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
    <div className={cn('mb-4', group.planMode && 'border-l-2 border-blue-500/30 pl-2 bg-blue-950/10 rounded-r')}>
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
            case 'thinking': {
              if (!showThinking && !expandAll) return null
              const isEncrypted = !item.text && typeof item.encryptedBytes === 'number'
              // Rough plaintext-equivalent estimate: base64 signature overhead ~1.33x.
              // Actual ciphertext is smaller than the signature blob since the blob
              // also contains envelope metadata (model, nonce, tag), but this gives
              // a reasonable "how much thinking" hint.
              const estBytes = isEncrypted ? Math.round((item.encryptedBytes as number) * 0.75) : 0
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                  key={i}
                  className="border-l-2 border-purple-400/40 pl-3 py-1"
                >
                  <div className="text-[10px] text-purple-400/70 uppercase font-bold tracking-wider mb-1 flex items-center gap-1.5">
                    <span>thinking</span>
                    {isEncrypted && (
                      <>
                        <span className="text-purple-400/40 normal-case font-normal tracking-normal">
                          encrypted, ~{estBytes}b
                        </span>
                        {item.rawBlock && (
                          <JsonInspector
                            title="encrypted thinking block"
                            data={item.rawBlock as unknown as Record<string, unknown>}
                          />
                        )}
                      </>
                    )}
                  </div>
                  {isEncrypted ? (
                    <div className="text-[11px] text-muted-foreground/50 italic font-mono">
                      Anthropic ships Claude 4.7 thinking as a signed/encrypted blob. Plaintext is not available to the
                      client.
                    </div>
                  ) : (
                    <div className="text-sm opacity-75">
                      <Markdown>{item.text}</Markdown>
                    </div>
                  )}
                </div>
              )
            }
            case 'project-task': {
              const prioColors: Record<string, string> = {
                high: 'border-l-red-500',
                medium: 'border-l-amber-500',
                low: 'border-l-blue-500',
              }
              const prioColor = prioColors[item.priority || 'medium'] || prioColors.medium
              const statusColors: Record<string, string> = {
                inbox: 'bg-zinc-500/20 text-zinc-400',
                open: 'bg-blue-500/20 text-blue-400',
                'in-progress': 'bg-amber-500/20 text-amber-400',
                'in-review': 'bg-purple-500/20 text-purple-400',
                done: 'bg-emerald-500/20 text-emerald-400',
              }
              const sColor = statusColors[item.taskStatus || ''] || statusColors.inbox
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                  key={i}
                  className={cn(
                    'rounded-lg border border-[#33467c]/40 bg-[#0d1b3e]/60 border-l-[3px] overflow-hidden',
                    prioColor,
                  )}
                >
                  <div className="px-3 py-2 flex items-center gap-2 border-b border-[#33467c]/30">
                    <span className="text-xs font-mono text-muted-foreground/50">TASK</span>
                    <span className="text-sm font-bold text-foreground/90 flex-1 truncate">{item.title}</span>
                    {item.taskStatus && (
                      <span
                        className={cn('px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded', sColor)}
                      >
                        {item.taskStatus}
                      </span>
                    )}
                    {item.priority && item.priority !== 'medium' && (
                      <span className="text-[9px] font-mono text-muted-foreground/40 uppercase">{item.priority}</span>
                    )}
                  </div>
                  {item.tags && item.tags.length > 0 && (
                    <div className="px-3 pt-1.5 flex gap-1 flex-wrap">
                      {item.tags.map(tag => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 text-[9px] font-mono bg-indigo-500/15 text-indigo-400/80 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {item.body && (
                    <div className="px-3 py-2 text-sm text-foreground/70">
                      <Markdown>{item.body}</Markdown>
                    </div>
                  )}
                  <div className="px-3 pb-1.5">
                    <span className="text-[9px] font-mono text-muted-foreground/30">{item.id}.md</span>
                  </div>
                </div>
              )
            }
            case 'text': {
              const isApiError = /^API Error:\s*\d+\s*\{/.test(item.text)
              return isApiError ? (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                  key={i}
                  className="text-sm px-3 py-2 bg-destructive/15 border border-destructive/40 rounded font-mono"
                >
                  <div className="text-destructive font-bold text-xs uppercase mb-1">API Error</div>
                  <pre className="text-[11px] text-destructive/80 whitespace-pre-wrap break-all">{item.text}</pre>
                </div>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
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
                // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
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
              if (item.isInterConversation) {
                const intentStyles: Record<string, string> = {
                  request: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
                  response: 'bg-green-400/15 text-green-400 border-green-400/30',
                  notify: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
                  progress: 'bg-zinc-400/15 text-zinc-400 border-zinc-400/30',
                }
                const iStyle = intentStyles[item.intent || ''] || intentStyles.notify
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                  <div key={i} className="rounded-lg border border-teal-500/30 bg-teal-500/5 px-3 py-2.5 my-1">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10px] font-mono text-teal-400/60">from</span>
                      <ConversationTag idOrSlug={item.sessionId || item.source || ''} className="text-xs" />
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
                      <Markdown copyable>{item.text}</Markdown>
                    </div>
                  </div>
                )
              }
              if (item.isDialog) {
                const statusStyles: Record<string, string> = {
                  submitted: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
                  cancelled: 'bg-zinc-500/15 text-muted-foreground border-zinc-500/20',
                  timeout: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
                }
                const sStyle = statusStyles[item.dialogStatus || 'submitted'] || statusStyles.submitted
                // Parse JSON values from the message
                let userValues: Array<[string, unknown]> = []
                try {
                  const parsed = JSON.parse(item.text)
                  if (typeof parsed === 'object' && parsed !== null) {
                    userValues = Object.entries(parsed)
                  }
                } catch {
                  /* not JSON, show as text */
                }

                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                  <div key={i} className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2.5 my-1">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10px] font-mono text-violet-400/60">dialog</span>
                      <span
                        className={cn(
                          'px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider border rounded',
                          sStyle,
                        )}
                      >
                        {item.dialogStatus || 'submitted'}
                      </span>
                      {item.dialogAction && (
                        <span className="px-1.5 py-0.5 bg-violet-500/20 text-violet-400 border border-violet-500/30 rounded text-[9px] font-bold">
                          {item.dialogAction}
                        </span>
                      )}
                    </div>
                    {userValues.length > 0 ? (
                      <div className="text-[11px] font-mono space-y-1">
                        {userValues.map(([key, val]) => (
                          <div key={key} className="flex items-start gap-2">
                            <span className="text-violet-400 font-bold shrink-0">{key}</span>
                            <span className="text-foreground/80 break-all">
                              {typeof val === 'boolean' ? (
                                <span
                                  className={cn(
                                    'px-1.5 py-0.5 rounded text-[9px] font-bold border',
                                    val
                                      ? 'bg-green-500/15 text-green-400 border-green-500/30'
                                      : 'bg-zinc-500/15 text-muted-foreground/50 border-zinc-500/20',
                                  )}
                                >
                                  {String(val)}
                                </span>
                              ) : Array.isArray(val) ? (
                                <span className="flex flex-wrap gap-1">
                                  {val.map((v, j) => (
                                    <span
                                      // biome-ignore lint/suspicious/noArrayIndexKey: display-only array values, no stable IDs
                                      key={j}
                                      className="px-1.5 py-0.5 bg-violet-500/15 text-violet-300 border border-violet-500/25 rounded text-[9px]"
                                    >
                                      {String(v)}
                                    </span>
                                  ))}
                                </span>
                              ) : typeof val === 'string' && val.length > 0 ? (
                                <span className="text-foreground/90">{val}</span>
                              ) : (
                                <span className="text-muted-foreground/50">{String(val)}</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm">
                        <Markdown>{item.text}</Markdown>
                      </div>
                    )}
                  </div>
                )
              }
              if (item.isSystem) {
                // Distinct color per known systemKind; default to amber for unknown system events.
                const systemStyle =
                  item.systemKind === 'timeout'
                    ? 'border-amber-500/40 bg-amber-500/5 text-amber-300/90'
                    : item.systemKind === 'error' || item.systemKind === 'failed'
                      ? 'border-red-500/40 bg-red-500/5 text-red-300/90'
                      : item.systemKind === 'ok' || item.systemKind === 'success'
                        ? 'border-green-500/40 bg-green-500/5 text-green-300/90'
                        : 'border-zinc-500/40 bg-zinc-500/5 text-zinc-300/90'
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                  <div key={i} className={cn('text-sm rounded-md border-l-2 px-3 py-2 my-1', systemStyle)}>
                    <div className="text-[10px] uppercase font-bold tracking-wider mb-1 opacity-70">
                      system{item.systemKind ? ` · ${item.systemKind}` : ''}
                    </div>
                    <Markdown>{item.text}</Markdown>
                  </div>
                )
              }
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                <div key={i} className="text-sm border-l-2 border-teal-400/40 pl-3 py-1">
                  <div className="text-[10px] text-teal-400/70 uppercase font-bold tracking-wider mb-1">
                    channel: {item.source}
                  </div>
                  <Markdown>{item.text}</Markdown>
                </div>
              )
            case 'bash':
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                <div key={i} className="text-sm">
                  <BashOutput result={item.text} />
                </div>
              )
            case 'tool':
              return (
                <MemoizedToolLine
                  // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                  key={i}
                  tool={item.tool}
                  result={item.result}
                  toolUseResult={item.extra}
                  isError={item.isError}
                  expandAll={expandAll}
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

// Collapsed skill content pill - expands to show full markdown
export function SkillDivider({ name, content }: { name: string; content: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="my-3">
      <button
        type="button"
        onClick={() => {
          haptic('tap')
          setExpanded(!expanded)
        }}
        className="flex items-center gap-2 w-full group"
      >
        <div
          className="flex-1 h-px"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, #2dd4bf 0px, #2dd4bf 8px, transparent 8px, transparent 16px)',
          }}
        />
        <span className="px-2 py-0.5 text-[10px] font-bold font-mono uppercase tracking-widest text-teal-400/80 bg-teal-400/10 border border-teal-400/30 shrink-0 flex items-center gap-1.5">
          <span className={cn('transition-transform text-[8px]', expanded ? 'rotate-90' : '')}>&#9654;</span>/{name}
        </span>
        <div
          className="flex-1 h-px"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, #2dd4bf 0px, #2dd4bf 8px, transparent 8px, transparent 16px)',
          }}
        />
      </button>
      {expanded && (
        <div className="mt-2 px-3 py-2 border border-teal-400/20 bg-teal-400/5 rounded text-xs max-h-[400px] overflow-y-auto">
          <Markdown>{content}</Markdown>
        </div>
      )}
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
