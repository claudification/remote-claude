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
      id: 'task',
      icon: <PenLine className="w-4 h-4" />,
      label: 'Task',
      action: () => window.dispatchEvent(new Event('open-quick-task')),
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

  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMainTap = useCallback(() => {
    const now = Date.now()
    if (now - lastTapRef.current < 300) {
      // Double-tap: cancel pending single-tap, alt-tab to previous session
      if (singleTapTimer.current) {
        clearTimeout(singleTapTimer.current)
        singleTapTimer.current = null
      }
      haptic('double')
      setExpanded(false)
      const { sessionMru, sessions, selectSession } = useSessionsStore.getState()
      // Find the most recent OTHER session that still exists
      const prev = sessionMru.slice(1).find(id => sessions.some(s => s.id === id))
      if (prev) selectSession(prev)
      lastTapRef.current = 0
      return
    }
    lastTapRef.current = now
    haptic('tap')
    // Delay toggle to allow double-tap detection
    singleTapTimer.current = setTimeout(() => {
      singleTapTimer.current = null
      setExpanded(prev => !prev)
    }, 300)
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

  // Vertical stack to the LEFT of the FAB, first button level with FAB, rest go down
  const buttonSpacing = 48 // 40px button + 8px gap
  const leftOffset = 52 // FAB width (44) + 8px gap

  return (
    <div data-action-fab className="fixed z-[56] right-3" style={{ width: 44, height: 44, top: 'calc(50% + 32px)' }}>
      {/* Action buttons - vertical stack to the left */}
      {actions.map((action, i) => (
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
            right: expanded ? leftOffset : 0,
            top: expanded ? i * buttonSpacing : 0,
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
      ))}

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
