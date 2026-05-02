/**
 * Action FAB - Mobile floating action button with vertical fan expansion
 *
 * Position: fixed bottom-right. Tap to expand fan of action buttons.
 * Double-tap the main button to alt-tab to previous session.
 * Actions are context-aware: shows terminate for active sessions,
 * revive/dismiss for ended sessions.
 * Mobile only - hidden on desktop (hover-capable devices).
 */

import { Command, ListChecks, MessageSquarePlus, PenLine, Power, RefreshCw, Rocket, Share2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { projectPath, type Session } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { openReviveDialog } from './revive-dialog'
import { openSpawnDialog } from './spawn-dialog'
import { openTerminateConfirm } from './terminate-confirm'

interface FanAction {
  id: string
  icon: React.ReactNode
  label: string
  action: () => void
  color: string
  /** Dangerous actions get extra spacing and require confirmation */
  dangerous?: boolean
}

function buildActions(session: Session | undefined, selectedConversationId: string | null): FanAction[] {
  const actions: FanAction[] = [
    {
      id: 'switcher',
      icon: <Command className="w-4 h-4" />,
      label: 'Switcher',
      action: () => useConversationsStore.getState().toggleSwitcher(),
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
      id: 'batch-tasks',
      icon: <ListChecks className="w-4 h-4" />,
      label: 'Batch',
      action: () => window.dispatchEvent(new Event('open-batch-selector')),
      color: 'bg-[#2ac3de]',
    },
    {
      id: 'launch',
      icon: <Rocket className="w-4 h-4" />,
      label: 'Launch',
      action: () => openSpawnDialog({ cwd: session ? projectPath(session.project) : '.' }),
      color: 'bg-[#ff9e64]',
    },
    {
      id: 'spawn',
      icon: <MessageSquarePlus className="w-4 h-4" />,
      label: 'Spawn',
      action: () => useConversationsStore.getState().openSwitcherWithFilter('S:~/'),
      color: 'bg-[#e0af68]',
    },
  ]

  if (session && selectedConversationId) {
    if (session.status !== 'ended') {
      // Active session actions
      actions.push({
        id: 'share',
        icon: <Share2 className="w-4 h-4" />,
        label: 'Share',
        action: () => useConversationsStore.getState().openTab(selectedConversationId, 'shared'),
        color: 'bg-[#bb9af7]',
      })
      actions.push({
        id: 'terminate',
        icon: <Power className="w-4 h-4" />,
        label: 'Terminate',
        action: () => {
          // Open the proper modal -- inline two-tap confirm was easy to miss on
          // mobile and left the action looking unresponsive. This matches the
          // ⌘K X / ⌘G X command palette path.
          const name = session.title || session.agentName || null
          openTerminateConfirm(session.id, name)
        },
        color: 'bg-red-500',
      })
    } else {
      // Ended session actions
      actions.push({
        id: 'revive',
        icon: <RefreshCw className="w-4 h-4" />,
        label: 'Revive...',
        action: () => {
          useConversationsStore.getState().selectConversation(session.id)
          openReviveDialog({ conversationId: session.id })
        },
        color: 'bg-emerald-500',
      })
      actions.push({
        id: 'dismiss',
        icon: <Trash2 className="w-4 h-4" />,
        label: 'Dismiss',
        action: () => useConversationsStore.getState().dismissConversation(session.id),
        color: 'bg-red-500/80',
        dangerous: true,
      })
    }
  }

  return actions
}

export function ActionFab() {
  const [expanded, setExpanded] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const lastTapRef = useRef(0)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const session = useConversationsStore(state =>
    state.selectedConversationId ? state.sessionsById[state.selectedConversationId] : undefined,
  )

  const actions = buildActions(session, selectedConversationId)

  // Compute cumulative Y offsets with extra gap before dangerous actions
  const offsets = actions.reduce<number[]>((acc, action, i) => {
    const prevBottom = i === 0 ? 0 : acc[i - 1]
    const gap = action.dangerous ? 60 : 44 // extra spacing for dangerous
    acc.push(prevBottom + gap)
    return acc
  }, [])

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
      const { sessionMru, sessions, selectConversation } = useConversationsStore.getState()
      const prev = sessionMru.slice(1).find(id => sessions.some(s => s.id === id))
      if (prev) selectConversation(prev)
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

  // Clear confirmation when fan closes
  useEffect(() => {
    if (!expanded) setConfirmId(null)
  }, [expanded])

  return (
    <div data-action-fab className="fixed z-[56] right-3" style={{ width: 44, height: 44, top: 'calc(50% + 32px)' }}>
      {/* Action buttons - vertical stack going UP from the FAB */}
      {actions.map((action, i) => (
        <div
          key={action.id}
          className={cn(
            'absolute flex items-center gap-2 transition-all duration-200 ease-out',
            expanded ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
          style={{
            right: 0,
            bottom: expanded ? offsets[i] + 4 : 0,
            transitionDelay: expanded ? `${i * 30}ms` : '0ms',
          }}
        >
          {/* Label */}
          <span
            className={cn(
              'px-2 py-0.5 rounded text-[10px] font-mono font-bold whitespace-nowrap',
              'bg-black/70 text-white/90 border border-white/10',
              'transition-all duration-200',
              expanded ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0',
              confirmId === action.id && 'border-red-500/50 text-red-300',
            )}
            style={{ transitionDelay: expanded ? `${i * 30 + 50}ms` : '0ms' }}
          >
            {confirmId === action.id ? `${action.label}?` : action.label}
          </span>
          {/* Button */}
          <button
            type="button"
            className={cn(
              'w-10 h-10 rounded-full flex items-center justify-center shrink-0',
              'shadow-md border border-white/10 text-white',
              'transition-transform duration-200 ease-out active:scale-90',
              action.color,
              expanded ? 'scale-100' : 'scale-0',
              confirmId === action.id && 'ring-2 ring-red-500/60 animate-pulse',
            )}
            style={{ transitionDelay: expanded ? `${i * 30}ms` : '0ms' }}
            onClick={e => {
              e.stopPropagation()
              if (action.dangerous && confirmId !== action.id) {
                // First tap on dangerous action: show confirmation
                haptic('tick')
                setConfirmId(action.id)
                return
              }
              haptic('tap')
              action.action()
              setExpanded(false)
              setConfirmId(null)
            }}
          >
            {action.icon}
          </button>
        </div>
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
