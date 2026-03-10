import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useRef } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import type { HookEvent } from '@/lib/types'
import { EventItem } from './event-detail'

interface EventsViewProps {
  events: HookEvent[]
  follow?: boolean
  onUserScroll?: () => void
}

export function EventsView({ events, follow = false, onUserScroll }: EventsViewProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const followKilledRef = useRef(false)

  // Reverse events so most recent is at top
  const reversed = [...events].reverse()

  const virtualizer = useVirtualizer({
    count: reversed.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 100,
    overscan: 5,
  })

  useEffect(() => {
    if (follow) followKilledRef.current = false
  }, [follow])

  const killFollow = useCallback(
    (e: React.WheelEvent | React.TouchEvent) => {
      if (!follow) return
      // Reversed list: scroll DOWN (deltaY > 0) = away from newest
      if ('deltaY' in e && e.deltaY <= 0) return
      followKilledRef.current = true
      onUserScroll?.()
    },
    [follow, onUserScroll],
  )

  // Follow mode: scroll to top (newest first) when new data arrives
  const newDataSeq = useSessionsStore(state => state.newDataSeq)
  useEffect(() => {
    if (!follow || followKilledRef.current || reversed.length === 0) return
    const el = parentRef.current
    if (!el) return
    requestAnimationFrame(() => {
      if (followKilledRef.current) return
      if (el.scrollTop > 1) {
        el.scrollTo({ top: 0, behavior: 'instant' })
      }
    })
  }, [follow, newDataSeq, reversed.length])

  if (reversed.length === 0) {
    return (
      <div className="text-muted-foreground text-center py-10">
        <pre className="text-xs">
          {`
┌─────────────────────────┐
│                         │
│   [ NO EVENTS ]         │
│                         │
│   Waiting for data...   │
│   _                     │
│                         │
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
            <EventItem event={reversed[virtualItem.index]} />
          </div>
        ))}
      </div>
    </div>
  )
}
