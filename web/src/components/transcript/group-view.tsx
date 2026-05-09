import { memo } from 'react'
import { cn } from '@/lib/utils'
import { BootTimeline } from './boot-timeline'
import { ChatBubble } from './chat-bubble'
import type { RenderItem, ResultLookup, SubagentRef, TranscriptSettings } from './group-view-types'
import type { DisplayGroup } from './grouping'
import { BashItem, ChannelItem, ImagesItem, ProjectTaskItem, TextItem, ThinkingItem, ToolItem } from './item-renderers'
import { LaunchTimeline } from './launch-timeline'
import { parseGroupEntries } from './parse-entries'
import { SystemLine } from './system-line'
import { TaskNotificationLine } from './task-notification-line'

export { CompactedDivider, CompactingBanner } from './compacted-divider'
export { BUBBLE_COLOR_OPTIONS } from './group-view-types'
export { SkillDivider } from './skill-divider'

function GroupView({
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
  const items = parseGroupEntries(group.entries, getResult)

  const effortBadge =
    isUser && items.some(it => it.kind === 'text' && /\bultrathink\b/i.test(it.text))
      ? { symbol: '●', label: 'high' }
      : null

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

  const hasInterSessionContent = items.some(
    it => it.kind === 'channel' && (it.isInterConversation || it.isDialog || it.isSystem),
  )
  const hasProjectTask = items.some(it => it.kind === 'project-task')

  if (chatBubbles && isUser && !hasInterSessionContent && !hasProjectTask) {
    return (
      <ChatBubble
        items={items}
        time={time}
        bubbleColor={bubbleColor}
        sizeClass={sizeClass}
        queued={group.queued}
        channelServer={channelServer}
        effortBadge={effortBadge}
      />
    )
  }

  return (
    <div className={cn('mb-4', group.planMode && 'border-l-2 border-blue-500/30 pl-2 bg-blue-950/10 rounded-r')}>
      <GroupHeader
        label={label}
        customColor={customColor}
        borderColor={borderColor}
        labelBg={labelBg}
        sizeClass={sizeClass}
        channelServer={channelServer}
        effortBadge={effortBadge}
        queued={group.queued}
        time={time}
      />
      <div className={cn('pl-4 space-y-2', group.queued && 'opacity-50')}>
        {items.map((item, i) => (
          <GroupItem
            // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
            key={i}
            item={item}
            showThinking={showThinking}
            expandAll={expandAll}
            subagents={subagents}
            planContext={planContext}
          />
        ))}
      </div>
    </div>
  )
}

function GroupHeader({
  label,
  customColor,
  borderColor,
  labelBg,
  sizeClass,
  channelServer,
  effortBadge,
  queued,
  time,
}: {
  label: string
  customColor: string
  borderColor: string
  labelBg: string
  sizeClass: string
  channelServer?: string
  effortBadge: { symbol: string; label: string } | null
  queued?: boolean
  time: string
}) {
  return (
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
      {queued && (
        <span className="px-1.5 py-0.5 text-[10px] font-mono text-amber-400/70 bg-amber-400/10 animate-pulse">
          queued
        </span>
      )}
      <span className="text-muted-foreground text-[10px]">{time}</span>
      <span className={cn('flex-1 text-[10px] overflow-hidden', borderColor)}>{'─'.repeat(40)}</span>
    </div>
  )
}

function GroupItem({
  item,
  showThinking,
  expandAll,
  subagents,
  planContext,
}: {
  item: RenderItem
  showThinking: boolean
  expandAll: boolean
  subagents?: SubagentRef
  planContext?: { content: string; path?: string }
}) {
  switch (item.kind) {
    case 'thinking':
      if (!showThinking && !expandAll) return null
      return <ThinkingItem item={item} />
    case 'project-task':
      return <ProjectTaskItem item={item} />
    case 'text':
      return <TextItem item={item} />
    case 'images':
      return <ImagesItem item={item} />
    case 'channel':
      return <ChannelItem item={item} />
    case 'bash':
      return <BashItem item={item} />
    case 'tool':
      return <ToolItem item={item} expandAll={expandAll} subagents={subagents} planContext={planContext} />
    default:
      return null
  }
}

export const MemoizedGroupView = memo(GroupView)
