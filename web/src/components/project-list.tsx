import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type ConversationStructure,
  saveProjectOrder,
  useConversationStructure,
  useConversationsStore,
} from '@/hooks/use-conversations'
import type { ProjectOrder, ProjectOrderGroup, ProjectOrderNode } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { MaybeProfiler } from './perf-profiler'
import { ConversationCompactPeek, InactiveProjectItem } from './project-list/conversation-item'
import { GroupNode, NewGroupDropTarget, SortableNode } from './project-list/conversation-sorting'
import { PinnedProjectNode, ProjectNode } from './project-list/project-node'

// ─── Main ProjectList ──────────────────────────────────────────────

export function ProjectList() {
  // Subscribes only to the structural shape (id+project+status+capabilities+
  // startedAt). Per-conversation field churn (tokenUsage, recap, stats, gitBranch,
  // streaming text, lastActivity) does NOT re-render ProjectList -- leaf
  // items subscribe to their own conversation by id and render in isolation.
  // lastActivity is intentionally excluded: it changes on every WS message
  // and is only used here for sorting ended conversations, where the value is
  // snapshotted lazily at sort time (see `inactive` memo below).
  const structure = useConversationStructure()
  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const rawProjectOrder = useConversationsStore(s => s.projectOrder)
  const projectOrder = rawProjectOrder?.tree ? rawProjectOrder : { tree: [] }
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const showEnded = useConversationsStore(s => s.controlPanelPrefs.showEndedConversations)
  const showInactive = useConversationsStore(s => s.controlPanelPrefs.showInactiveByDefault)
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)
  const [_pulseConversationId, setPulseConversationId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('collapsed-groups')
      return stored ? new Set(JSON.parse(stored)) : new Set()
    } catch {
      return new Set()
    }
  })

  // Refresh timestamps periodically
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // Single id -> structure index shared by the grouping memos below.
  const structureById = useMemo(() => {
    const map = new Map<string, ConversationStructure>()
    for (const s of structure) map.set(s.id, s)
    return map
  }, [structure])

  // Group conversation IDs by project URI.
  const idsByProject = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const s of structure) {
      const group = map.get(s.project) || []
      group.push(s.id)
      map.set(s.project, group)
    }
    return map
  }, [structure])

  // Filtered view: hide ended conversations from project groups when toggle is off.
  const visibleIdsByProject = useMemo(() => {
    if (showEnded) return idsByProject
    const map = new Map<string, string[]>()
    for (const [project, ids] of idsByProject) {
      const filtered = ids.filter(id => structureById.get(id)?.status !== 'ended')
      if (filtered.length > 0) map.set(project, filtered)
    }
    return map
  }, [idsByProject, showEnded, structureById])

  // Track which projects are in the organized tree (by project URI).
  const treeProjects = useMemo(() => {
    const projects = new Set<string>()
    function walk(nodes: ProjectOrderNode[]) {
      for (const n of nodes) {
        if (n.type === 'project') {
          projects.add(n.id)
        } else if (n.type === 'group') {
          walk(n.children)
        }
      }
    }
    walk(projectOrder.tree)
    return projects
  }, [projectOrder])

  // Pinned projects not in tree (show even with 0 conversations)
  const pinnedNotInTree = useMemo(() => {
    const result: string[] = []
    for (const [uri, ps] of Object.entries(projectSettings)) {
      if (ps.pinned && !treeProjects.has(uri) && !visibleIdsByProject.has(uri)) {
        result.push(uri)
      }
    }
    return result
  }, [projectSettings, treeProjects, visibleIdsByProject])

  // Unorganized active conversations (uses visibleIdsByProject to respect showEnded filter)
  const unorganized = useMemo(() => {
    const seen = new Set<string>()
    const result: Array<{ project: string; conversationIds: string[] }> = []
    for (const s of structure) {
      if (s.status !== 'ended' && !treeProjects.has(s.project) && !seen.has(s.project)) {
        seen.add(s.project)
        const ids = visibleIdsByProject.get(s.project) || []
        if (ids.length > 0) result.push({ project: s.project, conversationIds: ids })
      }
    }
    result.sort((a, b) => {
      const aAllAdHoc = a.conversationIds.every(id => structureById.get(id)?.capabilities?.includes('ad-hoc'))
      const bAllAdHoc = b.conversationIds.every(id => structureById.get(id)?.capabilities?.includes('ad-hoc'))
      if (aAllAdHoc !== bAllAdHoc) return aAllAdHoc ? 1 : -1
      const aMax = Math.max(...a.conversationIds.map(id => structureById.get(id)?.startedAt ?? 0))
      const bMax = Math.max(...b.conversationIds.map(id => structureById.get(id)?.startedAt ?? 0))
      return bMax - aMax
    })
    return result
  }, [structure, treeProjects, visibleIdsByProject, structureById])

  // Inactive conversations (ended, not in tree, not in unorganized).
  // lastActivity is read lazily from the live store at sort time -- ended
  // conversations rarely tick, and excluding it from the structural selector
  // saves a ProjectList re-render on every WS message.
  const inactive = useMemo(() => {
    const activeProjects = new Set(structure.filter(s => s.status !== 'ended').map(s => s.project))
    const byProject = new Map<string, ConversationStructure[]>()
    for (const s of structure) {
      if (s.status === 'ended' && !treeProjects.has(s.project) && !activeProjects.has(s.project)) {
        const group = byProject.get(s.project) || []
        group.push(s)
        byProject.set(s.project, group)
      }
    }
    const conversationsById = useConversationsStore.getState().conversationsById
    const lastActivityOf = (id: string) => conversationsById[id]?.lastActivity ?? 0
    return Array.from(byProject.values()).sort((a, b) => {
      const aMax = Math.max(...a.map(s => lastActivityOf(s.id)))
      const bMax = Math.max(...b.map(s => lastActivityOf(s.id)))
      return bMax - aMax
    })
  }, [structure, treeProjects])

  // Toggle group collapse
  function toggleGroup(groupId: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      localStorage.setItem('collapsed-groups', JSON.stringify([...next]))
      return next
    })
  }

  // Scroll into view + pulse when conversation is selected (e.g. via Ctrl+K)
  // Groups stay collapsed -- the selected conversation "peeks" below the group header
  useEffect(() => {
    if (!selectedConversationId) return
    setPulseConversationId(selectedConversationId)
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-conversation-id="${selectedConversationId}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        el.classList.add('conversation-pulse')
        setTimeout(() => el.classList.remove('conversation-pulse'), 1500)
      }
    })
    const timer = setTimeout(() => setPulseConversationId(null), 1500)
    return () => clearTimeout(timer)
  }, [selectedConversationId])

  // Rename group
  const handleRename = useCallback(
    (groupId: string, newName: string) => {
      function renameInTree(nodes: ProjectOrderNode[]): ProjectOrderNode[] {
        return nodes.map(n => {
          if (n.type === 'group' && n.id === groupId) return { ...n, name: newName }
          if (n.type === 'group') return { ...n, children: renameInTree(n.children) }
          return n
        })
      }
      const newOrder: ProjectOrder = { tree: renameInTree(projectOrder.tree) }
      useConversationsStore.getState().setProjectOrder(newOrder)
      saveProjectOrder(newOrder)
    },
    [projectOrder],
  )

  // Flatten tree + unorganized into sortable IDs
  const sortableIds = useMemo(() => {
    const ids: string[] = []
    for (const node of projectOrder.tree) {
      ids.push(node.id) // group or root conversation
      if (node.type === 'group' && !collapsedGroups.has(node.id)) {
        for (const child of node.children) ids.push(child.id)
      }
    }
    for (const { project } of unorganized) ids.push(project)
    for (const uri of pinnedNotInTree) ids.push(uri)
    return ids
  }, [projectOrder, unorganized, pinnedNotInTree, collapsedGroups])

  // Sensors: mouse (8px) + touch (300ms long-press)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
  )
  const [isDragging, setIsDragging] = useState(false)

  // Find which group an ID belongs to
  function findParentGroup(id: string): string | null {
    for (const node of projectOrder.tree) {
      if (node.type === 'group') {
        if (node.children.some(c => c.id === id)) return node.id
      }
    }
    return null
  }

  function handleDragEnd(event: DragEndEvent) {
    setIsDragging(false)
    const { active, over } = event
    if (!over || active.id === over.id) return
    haptic('tick')

    const draggedId = active.id as string
    const overId = over.id as string

    // Drop onto "new group" target
    if (overId === '__new_group__') {
      const name = window.prompt('Group name:')
      if (!name?.trim()) return
      const groupId = `group-${name.trim().toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`
      // Remove from current position
      const newTree = removeFromTree(projectOrder.tree, draggedId)
      // Add new group with this item
      const conversationNode = draggedId.startsWith('group-')
        ? projectOrder.tree.find(n => n.id === draggedId) // dragging a group into a new group? just rename
        : { id: draggedId, type: 'project' as const }
      if (conversationNode) {
        newTree.push({
          id: groupId,
          type: 'group',
          name: name.trim(),
          children: [conversationNode.type === 'group' ? conversationNode : { id: draggedId, type: 'project' }],
        })
      }
      persistTree(newTree)
      return
    }

    // Is the over target a group header?
    const overIsGroup = overId.startsWith('group-')
    const draggedIsGroup = draggedId.startsWith('group-')
    const draggedIsInTree = projectOrder.tree.some(n => n.id === draggedId) || findParentGroup(draggedId) !== null
    const overIsInTree = projectOrder.tree.some(n => n.id === overId) || findParentGroup(overId) !== null

    if (draggedIsGroup && overIsGroup) {
      // Reorder groups at root level
      const newTree = [...projectOrder.tree]
      const fromIdx = newTree.findIndex(n => n.id === draggedId)
      const toIdx = newTree.findIndex(n => n.id === overId)
      if (fromIdx === -1 || toIdx === -1) return
      const [moved] = newTree.splice(fromIdx, 1)
      newTree.splice(toIdx, 0, moved)
      persistTree(newTree)
    } else if (overIsGroup && !draggedIsGroup) {
      // Drop conversation into a group
      const newTree = removeFromTree(projectOrder.tree, draggedId)
      const targetGroup = newTree.find(n => n.id === overId && n.type === 'group') as ProjectOrderGroup | undefined
      if (targetGroup) {
        targetGroup.children.push({
          id: draggedId,
          type: 'project',
        })
      }
      persistTree(newTree)
    } else if (overIsInTree && !draggedIsInTree) {
      // Drag unorganized onto organized -> pin it (insert near target)
      const overParent = findParentGroup(overId)
      const newTree = [...projectOrder.tree]
      const conversationId = draggedId
      if (overParent) {
        const group = newTree.find(n => n.id === overParent && n.type === 'group') as ProjectOrderGroup | undefined
        if (group) {
          const idx = group.children.findIndex(c => c.id === overId)
          group.children.splice(idx >= 0 ? idx : group.children.length, 0, { id: conversationId, type: 'project' })
        }
      } else {
        const idx = newTree.findIndex(n => n.id === overId)
        newTree.splice(idx >= 0 ? idx : newTree.length, 0, { id: conversationId, type: 'project' })
      }
      persistTree(newTree)
    } else if (draggedIsInTree && !overIsInTree) {
      // Drag organized onto unorganized -> unpin
      const newTree = removeFromTree(projectOrder.tree, draggedId)
      persistTree(newTree)
    } else if (draggedIsInTree && overIsInTree) {
      // Reorder within tree
      const newTree = removeFromTree(projectOrder.tree, draggedId)
      const draggedNode: ProjectOrderNode = { id: draggedId, type: 'project' }
      // Find original node data (might be a group)
      const origNode = findInTree(projectOrder.tree, draggedId)
      const nodeToInsert = origNode || draggedNode

      const overParent = findParentGroup(overId)
      if (overParent) {
        const group = newTree.find(n => n.id === overParent && n.type === 'group') as ProjectOrderGroup | undefined
        if (group) {
          const idx = group.children.findIndex(c => c.id === overId)
          group.children.splice(idx >= 0 ? idx : group.children.length, 0, nodeToInsert)
        }
      } else {
        const idx = newTree.findIndex(n => n.id === overId)
        newTree.splice(idx >= 0 ? idx : newTree.length, 0, nodeToInsert)
      }
      persistTree(newTree)
    }
  }

  function removeFromTree(tree: ProjectOrderNode[], id: string): ProjectOrderNode[] {
    return tree
      .filter(n => n.id !== id)
      .map(n => {
        if (n.type === 'group') return { ...n, children: n.children.filter(c => c.id !== id) }
        return n
      })
  }

  function findInTree(tree: ProjectOrderNode[], id: string): ProjectOrderNode | null {
    for (const n of tree) {
      if (n.id === id) return n
      if (n.type === 'group') {
        const found = n.children.find(c => c.id === id)
        if (found) return found
      }
    }
    return null
  }

  function persistTree(tree: ProjectOrderNode[]) {
    const newOrder: ProjectOrder = { tree }
    useConversationsStore.getState().setProjectOrder(newOrder)
    saveProjectOrder(newOrder)
  }

  if (structure.length === 0) {
    return (
      <div className="text-muted-foreground text-center py-10">
        <pre className="text-xs mb-4">
          {`
  No conversations yet

  Start a conversation with:
  $ rclaude
`.trim()}
        </pre>
      </div>
    )
  }

  const hasOrganized = projectOrder.tree.length > 0
  // Project URI of the currently-selected conversation, looked up lazily
  // from the structural shape so we don't have to subscribe to conversationsById.
  const selectedProject = selectedConversationId ? structure.find(s => s.id === selectedConversationId)?.project : null

  return (
    <MaybeProfiler id="ProjectList">
      <div className="space-y-2 overflow-y-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => setIsDragging(true)}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setIsDragging(false)}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {/* Organized tree */}
            {projectOrder.tree.map(node => {
              if (node.type === 'group') {
                const isCollapsed = collapsedGroups.has(node.id)
                return (
                  <SortableNode key={node.id} id={node.id}>
                    <GroupNode
                      group={node}
                      idsByProject={visibleIdsByProject}
                      collapsed={isCollapsed}
                      onToggle={() => toggleGroup(node.id)}
                      onRename={name => handleRename(node.id, name)}
                    />
                    {!isCollapsed ? (
                      <div className="space-y-1">
                        {node.children.map(child => {
                          if (child.type === 'group') return null
                          const childProject = child.id
                          const childIds = visibleIdsByProject.get(childProject)
                          if (!childIds || childIds.length === 0) {
                            if (projectSettings[childProject]?.pinned) {
                              return (
                                <SortableNode key={child.id} id={child.id}>
                                  <PinnedProjectNode project={childProject} />
                                </SortableNode>
                              )
                            }
                            return null
                          }
                          return (
                            <SortableNode key={child.id} id={child.id}>
                              <ProjectNode project={childProject} conversationIds={childIds} />
                            </SortableNode>
                          )
                        })}
                      </div>
                    ) : // Peek: show selected conversation even when group is collapsed.
                    // Use a per-id subscribed wrapper so the peek re-renders
                    // independently of ProjectList.
                    selectedConversationId && selectedProject && node.children.some(c => c.id === selectedProject) ? (
                      <div className="opacity-80">
                        <ConversationCompactPeek conversationId={selectedConversationId} />
                      </div>
                    ) : null}
                  </SortableNode>
                )
              }
              // Root-level conversation node
              const nodeProject = node.id
              const nodeIds = visibleIdsByProject.get(nodeProject)
              if (!nodeIds || nodeIds.length === 0) {
                if (projectSettings[nodeProject]?.pinned) {
                  return (
                    <SortableNode key={node.id} id={node.id}>
                      <PinnedProjectNode project={nodeProject} />
                    </SortableNode>
                  )
                }
                return null
              }
              return (
                <SortableNode key={node.id} id={node.id}>
                  <ProjectNode project={nodeProject} conversationIds={nodeIds} />
                </SortableNode>
              )
            })}

            {/* Drop target for new group */}
            <div
              className={cn(
                'mt-2 transition-all',
                isDragging ? 'opacity-100 max-h-16' : 'opacity-0 max-h-0 overflow-hidden',
              )}
            >
              <NewGroupDropTarget />
            </div>

            {/* Unorganized section */}
            {(unorganized.length > 0 || pinnedNotInTree.length > 0) && (
              <div>
                {hasOrganized && (
                  <div className="text-[10px] text-muted-foreground/50 font-bold uppercase tracking-wider px-1 mb-1 flex items-center gap-2">
                    <span>Unorganized</span>
                    <span className="flex-1 h-px bg-border" />
                  </div>
                )}
                <div className="space-y-1">
                  {pinnedNotInTree.map(uri => (
                    <SortableNode key={uri} id={uri}>
                      <PinnedProjectNode project={uri} />
                    </SortableNode>
                  ))}
                  {unorganized.map(({ project, conversationIds }, i) => {
                    // Insert separator before first ad-hoc-only group
                    const isAllAdHoc = conversationIds.every(id =>
                      structureById.get(id)?.capabilities?.includes('ad-hoc'),
                    )
                    const prevIsRegular =
                      i > 0 &&
                      !unorganized[i - 1].conversationIds.every(id =>
                        structureById.get(id)?.capabilities?.includes('ad-hoc'),
                      )
                    const showAdHocSeparator = isAllAdHoc && (i === 0 || prevIsRegular)
                    return (
                      <div key={project}>
                        {showAdHocSeparator && (
                          <div className="flex items-center gap-2 px-1 pt-2 pb-1">
                            <span className="flex-1 h-px bg-border" />
                            <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wider">ad-hoc</span>
                            <span className="flex-1 h-px bg-border" />
                          </div>
                        )}
                        <SortableNode id={project}>
                          <ProjectNode project={project} conversationIds={conversationIds} />
                        </SortableNode>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </SortableContext>
        </DndContext>

        {/* Inactive section */}
        {inactive.length > 0 && (
          <label className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => updatePrefs({ showInactiveByDefault: e.target.checked })}
              className="accent-primary"
            />
            show inactive ({inactive.length})
          </label>
        )}
        {showInactive &&
          inactive.map(group => <InactiveProjectItem key={group[0].project} conversationIds={group.map(s => s.id)} />)}
      </div>
    </MaybeProfiler>
  )
}
