import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { saveProjectOrder, updateProjectSettings, useConversationsStore, wsSend } from '@/hooks/use-conversations'
import type { Conversation, ProjectOrder, ProjectOrderGroup } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { RecapSubmenu } from '../recap-jobs/recap-submenu'
import { openReviveDialog } from '../revive-dialog'
import { openManageProjectLinks } from '../settings/manage-project-links-dialog'
import { openSpawnDialog } from '../spawn-dialog'

// ─── Conversation context menu (right-click) ─────────────────────────────

const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

// Grouping actions that operate on a project key (shared by conversation + project menus).
function useProjectGroupingActions(project: string) {
  const rawProjectOrder = useConversationsStore(s => s.projectOrder) as ProjectOrder | null
  const projectOrder = rawProjectOrder?.tree ? rawProjectOrder : { tree: [] }
  const groups = projectOrder.tree.filter((n): n is ProjectOrderGroup => n.type === 'group')

  function moveToGroup(groupId: string) {
    haptic('tap')
    const newTree = projectOrder.tree.map(node => {
      if (node.type === 'group') {
        const filtered = { ...node, children: node.children.filter(c => c.id !== project) }
        if (node.id === groupId) {
          return { ...filtered, children: [...filtered.children, { id: project, type: 'project' as const }] }
        }
        return filtered
      }
      return node
    })
    const rootFiltered = newTree.filter(n => n.id !== project)
    saveProjectOrder({ tree: rootFiltered })
  }

  function removeFromGroups() {
    haptic('tap')
    const newTree = projectOrder.tree.map(node => {
      if (node.type === 'group') {
        return { ...node, children: node.children.filter(c => c.id !== project) }
      }
      return node
    })
    if (!newTree.some(n => n.id === project)) {
      newTree.push({ id: project, type: 'project' as const })
    }
    saveProjectOrder({ tree: newTree })
  }

  function createGroupAndMove() {
    const name = prompt('Group name:')
    if (!name?.trim()) return
    haptic('tap')
    const groupId = `group-${name.trim().toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`
    let newTree = projectOrder.tree
      .filter(n => n.id !== project)
      .map(node => {
        if (node.type === 'group') {
          return { ...node, children: node.children.filter(c => c.id !== project) }
        }
        return node
      })
    newTree = [
      {
        id: groupId,
        type: 'group' as const,
        name: name.trim(),
        children: [{ id: project, type: 'project' as const }],
      },
      ...newTree,
    ]
    saveProjectOrder({ tree: newTree })
  }

  return { groups, moveToGroup, removeFromGroups, createGroupAndMove }
}

function GroupingMenuItems({ project }: { project: string }) {
  const { groups, moveToGroup, removeFromGroups, createGroupAndMove } = useProjectGroupingActions(project)
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

export function ConversationContextMenu({
  conversation,
  onOpenSettings,
  children,
}: {
  conversation: Conversation
  onOpenSettings?: () => void
  children: ReactNode
}) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)
  const selectConversation = useConversationsStore(s => s.selectConversation)
  const ps = useConversationsStore(s => s.projectSettings[conversation.project])

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <GroupingMenuItems project={conversation.project} />
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              useConversationsStore.getState().setRenamingConversationId(conversation.id)
            }}
          >
            Rename...
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              useConversationsStore.getState().setEditingDescriptionConversationId(conversation.id)
            }}
          >
            Edit description...
          </ContextMenu.Item>
          {/* Conversation-level "old recap" (per-conversation away_summary)
              kept for now; the new project-level period recap submenu lives
              below. wsSend('recap_request') is the legacy 20-word summary. */}
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              wsSend('recap_request', { conversationId: conversation.id })
            }}
          >
            Quick recap (this conversation)
          </ContextMenu.Item>
          <RecapSubmenu projectUri={conversation.project} label="Recap project" />
          {conversation.pendingTaskCount > 0 && (
            <ContextMenu.Item
              className={menuItemClass}
              onSelect={() => {
                haptic('tap')
                if (
                  confirm(
                    `Mark ${conversation.pendingTaskCount} pending task(s) as done?\n\nThis only updates the dashboard view. If the conversation reconnects, the agent host's task list will overwrite this.`,
                  )
                ) {
                  wsSend('mark_all_tasks_done', { conversationId: conversation.id })
                }
              }}
            >
              Mark all tasks as done
            </ContextMenu.Item>
          )}
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
              openSpawnDialog({ path: projectPath(conversation.project), projectUri: conversation.project })
            }}
          >
            Launch new...
          </ContextMenu.Item>
          <ContextMenu.Item
            className={cn(menuItemClass, 'text-info')}
            onSelect={() => {
              haptic('tap')
              selectConversation(conversation.id)
              window.dispatchEvent(new Event('open-batch-selector'))
            }}
          >
            Assign tasks...
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              openManageProjectLinks(conversation.project)
            }}
          >
            Manage links...
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              updateProjectSettings(conversation.project, { pinned: !ps?.pinned })
            }}
          >
            {ps?.pinned ? 'Unpin project' : 'Pin project'}
          </ContextMenu.Item>
          <ContextMenu.Separator className="h-px bg-border my-1" />
          {conversation.status !== 'ended' && (
            <ContextMenu.Item
              className={cn(menuItemClass, 'text-destructive')}
              onSelect={() => {
                haptic('error')
                useConversationsStore.getState().terminateConversation(conversation.id, 'dashboard-context-menu')
              }}
            >
              Terminate conversation
            </ContextMenu.Item>
          )}
          {conversation.status === 'ended' && (
            <>
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-emerald-400')}
                onSelect={() => {
                  haptic('tap')
                  selectConversation(conversation.id)
                  openReviveDialog({ conversationId: conversation.id })
                }}
              >
                Revive...
              </ContextMenu.Item>
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-destructive')}
                onSelect={() => {
                  haptic('tap')
                  dismissConversation(conversation.id)
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

function ProjectMenuItems({ project, onOpenSettings }: { project: string; onOpenSettings: () => void }) {
  const ps = useConversationsStore(s => s.projectSettings[project])
  return (
    <>
      <ContextMenu.Item
        className={cn(menuItemClass, 'text-cyan-400')}
        onSelect={() => {
          haptic('tap')
          openSpawnDialog({ path: projectPath(project), projectUri: project })
        }}
      >
        Launch new...
      </ContextMenu.Item>
      <RecapSubmenu projectUri={project} />
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          onOpenSettings()
        }}
      >
        Project settings...
      </ContextMenu.Item>
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          openManageProjectLinks(project)
        }}
      >
        Manage links...
      </ContextMenu.Item>
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          updateProjectSettings(project, { pinned: !ps?.pinned })
        }}
      >
        {ps?.pinned ? 'Unpin project' : 'Pin project'}
      </ContextMenu.Item>
    </>
  )
}

export function PinnedProjectContextMenu({
  project,
  onOpenSettings,
  children,
}: {
  project: string
  onOpenSettings: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <GroupingMenuItems project={project} />
          <ContextMenu.Separator className="h-px bg-border my-1" />
          <ProjectMenuItems project={project} onOpenSettings={onOpenSettings} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

export function ProjectContextMenu({
  project,
  conversations,
  onOpenSettings,
  children,
}: {
  project: string
  conversations: Conversation[]
  onOpenSettings: () => void
  children: ReactNode
}) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)
  const ended = conversations.filter(s => s.status === 'ended')

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <GroupingMenuItems project={project} />
          <ContextMenu.Separator className="h-px bg-border my-1" />
          <ProjectMenuItems project={project} onOpenSettings={onOpenSettings} />
          {ended.length > 0 && (
            <>
              <ContextMenu.Separator className="h-px bg-border my-1" />
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-destructive')}
                onSelect={() => {
                  haptic('tap')
                  for (const s of ended) dismissConversation(s.id)
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
