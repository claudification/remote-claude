import { Bell } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useState } from 'react'
import { NotificationPanel } from '@/components/notification-panel'
import { useConversationsStore } from '@/hooks/use-sessions'
import { useCommand } from '@/lib/commands'
import { haptic } from '@/lib/utils'

const EMPTY_PERMS: never[] = []
const EMPTY_LINKS: never[] = []
const EMPTY_ASKS: never[] = []
const EMPTY_NOTIFS: never[] = []
const EMPTY_DIALOGS: Record<string, never> = {}

export function NotificationBell() {
  const [open, setOpen] = useState(false)

  const perms = useConversationsStore(s => s.pendingPermissions) || EMPTY_PERMS
  const links = useConversationsStore(s => s.pendingProjectLinks) || EMPTY_LINKS
  const asks = useConversationsStore(s => s.pendingAskQuestions) || EMPTY_ASKS
  const notifs = useConversationsStore(s => s.notifications) || EMPTY_NOTIFS
  const dialogs = useConversationsStore(s => s.pendingDialogs) || EMPTY_DIALOGS

  const planApprovalCount = Object.values(dialogs).filter(d => d.source === 'plan_approval').length
  const totalCount = perms.length + links.length + asks.length + notifs.length + planApprovalCount

  useCommand('notifications', () => setOpen(o => !o), {
    shortcut: 'mod+g n',
    label: 'Notifications',
    group: 'Navigation',
  })

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            setOpen(o => !o)
          }}
          className="relative text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Notifications"
        >
          <Bell className="w-3.5 h-3.5" />
          {totalCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-amber-500 text-background text-[8px] font-bold leading-none px-0.5 animate-in zoom-in-50 duration-150">
              {totalCount > 99 ? '99+' : totalCount}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-80 sm:w-96 max-h-[70vh] overflow-y-auto rounded border border-border bg-background/95 backdrop-blur-sm shadow-lg font-mono"
          sideOffset={8}
          align="end"
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <NotificationPanel onClose={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
