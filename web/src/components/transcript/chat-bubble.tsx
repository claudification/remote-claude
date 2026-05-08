import { cn } from '@/lib/utils'
import { Markdown } from '../markdown'
import type { RenderItem } from './group-view-types'
import { BUBBLE_COLORS } from './group-view-types'

export function ChatBubble({
  items,
  time,
  bubbleColor,
  sizeClass,
  queued,
  channelServer,
  effortBadge,
}: {
  items: RenderItem[]
  time: string
  bubbleColor: string
  sizeClass: string
  queued?: boolean
  channelServer?: string
  effortBadge: { symbol: string; label: string } | null
}) {
  const bubbleBg = BUBBLE_COLORS[bubbleColor] || BUBBLE_COLORS.blue

  return (
    <div className="mb-3 flex justify-end">
      <div className={cn('max-w-[85%] sm:max-w-[75%]', queued && 'opacity-50')}>
        <div className={cn('rounded-2xl rounded-br-sm px-4 py-2.5 text-white', bubbleBg, sizeClass)}>
          {items.map((item, i) => {
            if (item.kind === 'text') {
              const hasBlocks = /^```/m.test(item.text) || /^\|.*\|.*\|/m.test(item.text)
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                  key={i}
                  className="text-sm [&_a]:text-primary-foreground/85 [&_a]:underline [&_a]:decoration-primary-foreground/40 [&_code]:!bg-black/25 [&_code]:!px-1.5 [&_code]:!py-0.5 [&_code]:!rounded-sm [&_code]:!text-primary-foreground/80 [&_code]:!text-[0.85em]"
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
