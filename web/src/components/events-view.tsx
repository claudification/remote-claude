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
  const programmaticScroll = useRef(false)

  // Reverse events so most recent is at top
  const reversed = [...events].reverse()

  const virtualizer = useVirtualizer({
    count: reversed.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 100,
    overscan: 5,
  })

  // Detect user scroll-down (away from top = away from newest) to disable follow
  useEffect(() => {
    const el = parentRef.current
    if (!el || !follow) return
    let lastScrollTop = el.scrollTop
    function handleScroll() {
      if (programmaticScroll.current || !el) return
      const currentScrollTop = el.scrollTop
      const scrolledDown = currentScrollTop > lastScrollTop
      lastScrollTop = currentScrollTop
      if (scrolledDown && currentScrollTop > 50) {
        onUserScroll?.()
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [follow, onUserScroll])

  const prevFollowRef = useRef(follow)

  useEffect(() => {
    const followJustEnabled = !prevFollowRef.current && follow
    prevFollowRef.current = follow
    if (!follow || reversed.length === 0) return
    programmaticScroll.current = true
    requestAnimationFrame(() => {
      const el = parentRef.current
      if (el) {
        el.scrollTo({ top: 0, behavior: followJustEnabled ? 'smooth' : 'instant' })
      }
      setTimeout(() => {
        programmaticScroll.current = false
      }, 200)
    })
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
