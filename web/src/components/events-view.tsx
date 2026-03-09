import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import type { HookEvent } from '@/lib/types'
import { EventItem } from './event-detail'

interface EventsViewProps {
  events: HookEvent[]
  follow?: boolean
  onUserScroll?: () => void
}

export function EventsView({ events, follow = false, onUserScroll }: EventsViewProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  // Reverse events so most recent is at top
  const reversed = [...events].reverse()

  const virtualizer = useVirtualizer({
    count: reversed.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 100,
    overscan: 5,
  })

  // Disable follow on any user scroll: wheel/touch are always user-initiated
  useEffect(() => {
    const el = parentRef.current
    if (!el || !follow) return
    function handleUserScroll() {
      onUserScroll?.()
    }
    el.addEventListener('wheel', handleUserScroll, { passive: true })
    el.addEventListener('touchstart', handleUserScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', handleUserScroll)
      el.removeEventListener('touchstart', handleUserScroll)
    }
  }, [follow, onUserScroll])

  // Follow mode: pin scroll to top (newest first)
  useEffect(() => {
    if (!follow || reversed.length === 0) return

    function scrollToTop() {
      const el = parentRef.current
      if (!el) return
      if (el.scrollTop > 1) {
        el.scrollTo({ top: 0, behavior: 'instant' })
      }
    }

    scrollToTop()
    const interval = setInterval(scrollToTop, 300)
    return () => clearInterval(interval)
  }, [follow, reversed.length])

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
    <div ref={parentRef} className="h-full overflow-y-auto p-3 sm:p-4">
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
