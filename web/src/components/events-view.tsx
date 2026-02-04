import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import type { HookEvent } from '@/lib/types'
import { EventItem } from './event-detail'

interface EventsViewProps {
	events: HookEvent[]
	follow?: boolean
}

export function EventsView({ events, follow = false }: EventsViewProps) {
	const parentRef = useRef<HTMLDivElement>(null)

	// Reverse events so most recent is at top
	const reversed = [...events].reverse()

	const virtualizer = useVirtualizer({
		count: reversed.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 100, // Estimate average event height
		overscan: 5,
	})

	// Auto-scroll to top (newest) when follow is enabled and content changes
	const prevCountRef = useRef(reversed.length)
	if (follow && reversed.length > prevCountRef.current && parentRef.current) {
		// Scroll to first item (newest event)
		virtualizer.scrollToIndex(0, { align: 'start' })
	}
	prevCountRef.current = reversed.length

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
		<div ref={parentRef} className="h-full overflow-y-auto">
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
