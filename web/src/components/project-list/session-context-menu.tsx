import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { saveProjectOrder, useSessionsStore } from '@/hooks/use-sessions'
import type { ProjectOrder, ProjectOrderGroup, Session } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { openReviveDialog } from '../revive-dialog'
import { openSpawnDialog } from '../spawn-dialog'

// ─── Session context menu (right-click) ─────────────────────────────

const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

// Grouping actions that operate on a cwd key (shared by session + project menus).
function useCwdGroupingActions(cwd: string) {
  const rawProjectOrder = useSessionsStore(s => s.projectOrder) as ProjectOrder | null
  const projectOrder = rawProjectOrder?.tree ? rawProjectOrder : { tree: [] }
  const groups = projectOrder.tree.filter((n): n is ProjectOrderGroup => n.type === 'group')
  const cwdKey = `cwd:${cwd}`

  function moveToGroup(groupId: string) {
    haptic('tap')
    const newTree = projectOrder.tree.map(node => {
      if (node.type === 'group') {
        const filtered = { ...node, children: node.children.filter(c => c.id !== cwdKey) }
        if (node.id === groupId) {
          return { ...filtered, children: [...filtered.children, { id: cwdKey, type: 'project' as const }] }
        }
        return filtered
      }
      return node
    })
    const rootFiltered = newTree.filter(n => n.id !== cwdKey)
    saveProjectOrder({ tree: rootFiltered })
  }

  function removeFromGroups() {
    haptic('tap')
    const newTree = projectOrder.tree.map(node => {
      if (node.type === 'group') {
        return { ...node, children: node.children.filter(c => c.id !== cwdKey) }
      }
      return node
    })
    if (!newTree.some(n => n.id === cwdKey)) {
      newTree.push({ id: cwdKey, type: 'project' as const })
    }
    saveProjectOrder({ tree: newTree })
  }

  function createGroupAndMove() {
    const name = prompt('Group name:')
    if (!name?.trim()) return
    haptic('tap')
    const groupId = `group-${name.trim().toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`
    let newTree = projectOrder.tree
      .filter(n => n.id !== cwdKey)
      .map(node => {
        if (node.type === 'group') {
          return { ...node, children: node.children.filter(c => c.id !== cwdKey) }
        }
        return node
      })
    newTree = [
      {
        id: groupId,
        type: 'group' as const,
        name: name.trim(),
        children: [{ id: cwdKey, type: 'project' as const }],
      },
      ...newTree,
    ]
    saveProjectOrder({ tree: newTree })
  }

  return { groups, moveToGroup, removeFromGroups, createGroupAndMove }
}

function GroupingMenuItems({ cwd }: { cwd: string }) {
  const { groups, moveToGroup, removeFromGroups, createGroupAndMove } = useCwdGroupingActions(cwd)
  return (
    <>
      {groups.length > 0 && (
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={menuItemClass}>
            Move to <span className="ml-auto text-muted-foreground">{'\u25B8'}</span>
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            <ContextMenu.SubContent className="min-w-[160px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
              {groups.map(g => (
                <ContextMenu.Item key={g.id} className={menuItemClass} onSelect={() => moveToGroup(g.id)}>
                  {g.name}
                </ContextMenu.Item>
              ))}
              <ContextMenu.Separator className="h-px bg-border my-1" />
              <ContextMenu.Item className={menuItemClass} onSelect={removeFromGroups}>
                Unpin (no group)
              </ContextMenu.Item>
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      )}
      <ContextMenu.Item className={menuItemClass} onSelect={createGroupAndMove}>
        New group...
      </ContextMenu.Item>
    </>
  )
}

export function SessionContextMenu({
  session,
  onOpenSettings,
  children,
}: {
  session: Session
  onOpenSettings?: () => void
  children: ReactNode
}) {
  const dismissSession = useSessionsStore(s => s.dismissSession)
  const selectSession = useSessionsStore(s => s.selectSession)

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <GroupingMenuItems cwd={session.cwd} />
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              useSessionsStore.getState().setRenamingSessionId(session.id)
            }}
          >
            Rename...
          </ContextMenu.Item>
          {onOpenSettings && (
            <ContextMenu.Item
              className={menuItemClass}
              onSelect={() => {
                haptic('tap')
                onOpenSettings()
              }}
            >
              Configuration...
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            className={cn(menuItemClass, 'text-cyan-400')}
            onSelect={() => {
              haptic('tap')
              openSpawnDialog({ cwd: session.cwd })
            }}
          >
            Launch new...
          </ContextMenu.Item>
          <ContextMenu.Item
            className={cn(menuItemClass, 'text-[#2ac3de]')}
            onSelect={() => {
              haptic('tap')
              selectSession(session.id)
              window.dispatchEvent(new Event('open-batch-selector'))
            }}
          >
            Assign tasks...
          </ContextMenu.Item>
          <ContextMenu.Separator className="h-px bg-border my-1" />
          {session.status !== 'ended' && (
            <ContextMenu.Item
              className={cn(menuItemClass, 'text-destructive')}
              onSelect={() => {
                haptic('error')
                useSessionsStore.getState().terminateSession(session.id)
              }}
            >
              Terminate session
            </ContextMenu.Item>
          )}
          {session.status === 'ended' && (
            <>
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-emerald-400')}
                onSelect={() => {
                  haptic('tap')
                  selectSession(session.id)
                  openReviveDialog({ sessionId: session.id })
                }}
              >
                Revive...
              </ContextMenu.Item>
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-destructive')}
                onSelect={() => {
                  haptic('tap')
                  dismissSession(session.id)
                }}
              >
                Dismiss
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

export function ProjectContextMenu({
  cwd,
  sessions,
  onOpenSettings,
  children,
}: {
  cwd: string
  sessions: Session[]
  onOpenSettings: () => void
  children: ReactNode
}) {
  const dismissSession = useSessionsStore(s => s.dismissSession)
  const ended = sessions.filter(s => s.status === 'ended')

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <GroupingMenuItems cwd={cwd} />
          <ContextMenu.Separator className="h-px bg-border my-1" />
          <ContextMenu.Item
            className={cn(menuItemClass, 'text-cyan-400')}
            onSelect={() => {
              haptic('tap')
              openSpawnDialog({ cwd })
            }}
          >
            Launch new...
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              onOpenSettings()
            }}
          >
            Project settings...
          </ContextMenu.Item>
          {ended.length > 0 && (
            <>
              <ContextMenu.Separator className="h-px bg-border my-1" />
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-destructive')}
                onSelect={() => {
                  haptic('tap')
                  for (const s of ended) dismissSession(s.id)
                }}
              >
                Dismiss {ended.length} ended
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
