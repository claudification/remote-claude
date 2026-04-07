/**
 * Action FAB - Mobile floating action button with half-circle fan expansion
 *
 * Position: fixed bottom-right. Tap to expand fan of 4 action buttons.
 * Double-tap the main button to open the command palette directly.
 * Mobile only - hidden on desktop (hover-capable devices).
 */

import { Command, MessageSquarePlus, PenLine, Share2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { cn, haptic } from '@/lib/utils'

interface FanAction {
  id: string
  icon: React.ReactNode
  label: string
  action: () => void
  color: string
}

export function ActionFab() {
  const [expanded, setExpanded] = useState(false)
  const lastTapRef = useRef(0)
  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)

  const actions: FanAction[] = [
    {
      id: 'switcher',
      icon: <Command className="w-4 h-4" />,
      label: 'Switcher',
      action: () => useSessionsStore.getState().toggleSwitcher(),
      color: 'bg-[#7aa2f7]',
    },
    {
      id: 'note',
      icon: <PenLine className="w-4 h-4" />,
      label: 'Note',
      action: () => window.dispatchEvent(new Event('open-quick-note')),
      color: 'bg-[#9ece6a]',
    },
    {
      id: 'spawn',
      icon: <MessageSquarePlus className="w-4 h-4" />,
      label: 'Spawn',
      action: () => useSessionsStore.getState().openSwitcherWithFilter('S:./'),
      color: 'bg-[#e0af68]',
    },
    {
      id: 'share',
      icon: <Share2 className="w-4 h-4" />,
      label: 'Share',
      action: () => {
        if (selectedSessionId) {
          const store = useSessionsStore.getState()
          store.openTab(selectedSessionId, 'shared')
        }
      },
      color: 'bg-[#bb9af7]',
    },
  ]

  const handleMainTap = useCallback(() => {
    const now = Date.now()
    if (now - lastTapRef.current < 300) {
      // Double-tap: open switcher directly
      haptic('double')
      setExpanded(false)
      useSessionsStore.getState().toggleSwitcher()
      lastTapRef.current = 0
      return
    }
    lastTapRef.current = now
    haptic('tap')
    setExpanded(prev => !prev)
  }, [])

  // Close fan on outside tap
  useEffect(() => {
    if (!expanded) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('[data-action-fab]')) {
        setExpanded(false)
      }
    }
    document.addEventListener('click', handleClick, { capture: true })
    return () => document.removeEventListener('click', handleClick, { capture: true })
  }, [expanded])

  // Fan positions: half-circle upward from bottom-right
  // Angles from -135deg to -45deg (upper-left arc), evenly spaced
  const fanRadius = 72
  const angles = [-135, -105, -75, -45]

  return (
    <div data-action-fab className="fixed z-[54] right-3" style={{ width: 44, height: 44, top: 'calc(50% + 32px)' }}>
      {/* Fan action buttons */}
      {actions.map((action, i) => {
        const angle = (angles[i] * Math.PI) / 180
        const x = expanded ? Math.cos(angle) * fanRadius : 0
        const y = expanded ? Math.sin(angle) * fanRadius : 0

        return (
          <button
            key={action.id}
            type="button"
            className={cn(
              'absolute w-10 h-10 rounded-full flex items-center justify-center',
              'shadow-md border border-white/10 text-white',
              'transition-all duration-200 ease-out',
              action.color,
              expanded ? 'scale-100 opacity-100' : 'scale-0 opacity-0 pointer-events-none',
            )}
            style={{
              bottom: -y,
              right: -x,
              transitionDelay: expanded ? `${i * 30}ms` : '0ms',
            }}
            onClick={e => {
              e.stopPropagation()
              haptic('tap')
              action.action()
              setExpanded(false)
            }}
          >
            {action.icon}
          </button>
        )
      })}

      {/* Main FAB button */}
      <button
        type="button"
        className={cn(
          'absolute bottom-0 right-0 w-11 h-11 rounded-full flex items-center justify-center',
          'shadow-lg border transition-all duration-150',
          'touch-none select-none',
          expanded
            ? 'bg-[#33467c] border-[#7aa2f7]/50 text-[#7aa2f7] rotate-45'
            : 'bg-background/80 border-border/50 text-muted-foreground active:scale-95',
        )}
        onClick={handleMainTap}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          role="img"
          aria-label="Actions"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  )
}
