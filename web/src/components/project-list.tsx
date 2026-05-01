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
import { saveProjectOrder, useConversationsStore } from '@/hooks/use-sessions'
import type { ProjectOrder, ProjectOrderGroup, ProjectOrderNode, Session } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { MaybeProfiler } from './perf-profiler'
import { ProjectNode } from './project-list/project-node'
import { InactiveProjectItem, SessionItemCompact } from './project-list/session-item'
import { GroupNode, NewGroupDropTarget, SortableNode } from './project-list/session-sorting'

// ─── Main ProjectList ──────────────────────────────────────────────

export function ProjectList() {
  // Server already filters sessions_list by grants (filterSessionsByGrants) --
  // if a session made it here, the user has chat:read for its project.
  const sessions = useConversationsStore(s => s.sessions)
  const sessionsById = useConversationsStore(s => s.sessionsById)
  const selectedSessionId = useConversationsStore(s => s.selectedSessionId)
  const rawProjectOrder = useConversationsStore(s => s.projectOrder)
  const projectOrder = rawProjectOrder?.tree ? rawProjectOrder : { tree: [] }
  const showEnded = useConversationsStore(s => s.controlPanelPrefs.showEndedSessions)
  const showInactive = useConversationsStore(s => s.controlPanelPrefs.showInactiveByDefault)
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)
  const [_pulseSessionId, setPulseSessionId] = useState<string | null>(null)
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

  // Group all sessions by project URI
  const sessionsByCwd = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      const group = map.get(s.project) || []
      group.push(s)
      map.set(s.project, group)
    }
    return map
  }, [sessions])

  // Filtered view: hide ended sessions from project groups when toggle is off
  const visibleSessionsByCwd = useMemo(() => {
    if (showEnded) return sessionsByCwd
    const map = new Map<string, Session[]>()
    for (const [project, group] of sessionsByCwd) {
      const filtered = group.filter(s => s.status !== 'ended')
      if (filtered.length > 0) map.set(project, filtered)
    }
    return map
  }, [sessionsByCwd, showEnded])

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

  // Unorganized active sessions (uses visibleSessionsByCwd to respect showEnded filter)
  const unorganized = useMemo(() => {
    const seen = new Set<string>()
    const result: Array<{ project: string; sessions: Session[] }> = []
    for (const s of sessions) {
      if (s.status !== 'ended' && !treeProjects.has(s.project) && !seen.has(s.project)) {
        seen.add(s.project)
        const projectSessions = visibleSessionsByCwd.get(s.project) || []
        if (projectSessions.length > 0) result.push({ project: s.project, sessions: projectSessions })
      }
    }
    result.sort((a, b) => {
      // Ad-hoc-only groups sort below regular groups
      const aAllAdHoc = a.sessions.every(s => s.capabilities?.includes('ad-hoc'))
      const bAllAdHoc = b.sessions.every(s => s.capabilities?.includes('ad-hoc'))
      if (aAllAdHoc !== bAllAdHoc) return aAllAdHoc ? 1 : -1
      // Within same tier, sort by most recent
      const aMax = Math.max(...a.sessions.map(s => s.startedAt))
      const bMax = Math.max(...b.sessions.map(s => s.startedAt))
      return bMax - aMax
    })
    return result
  }, [sessions, treeProjects, visibleSessionsByCwd])

  // Inactive sessions (ended, not in tree, not in unorganized)
  const inactive = useMemo(() => {
    const activeProjects = new Set(sessions.filter(s => s.status !== 'ended').map(s => s.project))
    const byProject = new Map<string, Session[]>()
    for (const s of sessions) {
      if (s.status === 'ended' && !treeProjects.has(s.project) && !activeProjects.has(s.project)) {
        const group = byProject.get(s.project) || []
        group.push(s)
        byProject.set(s.project, group)
      }
    }
    return Array.from(byProject.values()).sort((a, b) => {
      const aMax = Math.max(...a.map(s => s.lastActivity))
      const bMax = Math.max(...b.map(s => s.lastActivity))
      return bMax - aMax
    })
  }, [sessions, treeProjects])

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

  // Scroll into view + pulse when session is selected (e.g. via Ctrl+K)
  // Groups stay collapsed -- the selected session "peeks" below the group header
  useEffect(() => {
    if (!selectedSessionId) return
    setPulseSessionId(selectedSessionId)
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-session-id="${selectedSessionId}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        el.classList.add('session-pulse')
        setTimeout(() => el.classList.remove('session-pulse'), 1500)
      }
    })
    const timer = setTimeout(() => setPulseSessionId(null), 1500)
    return () => clearTimeout(timer)
  }, [selectedSessionId])

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
      ids.push(node.id) // group or root session
      if (node.type === 'group' && !collapsedGroups.has(node.id)) {
        for (const child of node.children) ids.push(child.id)
      }
    }
    for (const { project } of unorganized) ids.push(project)
    return ids
  }, [projectOrder, unorganized, collapsedGroups])

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
      const sessionNode = draggedId.startsWith('group-')
        ? projectOrder.tree.find(n => n.id === draggedId) // dragging a group into a new group? just rename
        : { id: draggedId, type: 'project' as const }
      if (sessionNode) {
        newTree.push({
          id: groupId,
          type: 'group',
          name: name.trim(),
          children: [sessionNode.type === 'group' ? sessionNode : { id: draggedId, type: 'project' }],
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
      // Drop session into a group
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
      const sessionId = draggedId
      if (overParent) {
        const group = newTree.find(n => n.id === overParent && n.type === 'group') as ProjectOrderGroup | undefined
        if (group) {
          const idx = group.children.findIndex(c => c.id === overId)
          group.children.splice(idx >= 0 ? idx : group.children.length, 0, { id: sessionId, type: 'project' })
        }
      } else {
        const idx = newTree.findIndex(n => n.id === overId)
        newTree.splice(idx >= 0 ? idx : newTree.length, 0, { id: sessionId, type: 'project' })
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

  if (sessions.length === 0) {
    return (
      <div className="text-muted-foreground text-center py-10">
        <pre className="text-xs mb-4">
          {`
  No sessions yet

  Start a session with:
  $ rclaude
`.trim()}
        </pre>
      </div>
    )
  }

  const hasOrganized = projectOrder.tree.length > 0

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
                      sessionsByCwd={visibleSessionsByCwd}
                      collapsed={isCollapsed}
                      onToggle={() => toggleGroup(node.id)}
                      onRename={name => handleRename(node.id, name)}
                    />
                    {!isCollapsed ? (
                      <div className="space-y-1">
                        {node.children.map(child => {
                          if (child.type === 'group') return null
                          const childProject = child.id
                          const childSessions = visibleSessionsByCwd.get(childProject)
                          if (!childSessions || childSessions.length === 0) return null
                          return (
                            <SortableNode key={child.id} id={child.id}>
                              <ProjectNode project={childProject} sessions={childSessions} />
                            </SortableNode>
                          )
                        })}
                      </div>
                    ) : (
                      (() => {
                        // Peek: show selected session even when group is collapsed
                        if (!selectedSessionId) return null
                        const selectedSession = sessionsById[selectedSessionId]
                        if (!selectedSession) return null
                        if (!node.children.some(c => c.id === selectedSession.project)) return null
                        return (
                          <div className="opacity-80">
                            <SessionItemCompact session={selectedSession} />
                          </div>
                        )
                      })()
                    )}
                  </SortableNode>
                )
              }
              // Root-level session node
              const nodeProject = node.id
              const nodeSessions = visibleSessionsByCwd.get(nodeProject)
              if (!nodeSessions || nodeSessions.length === 0) return null
              return (
                <SortableNode key={node.id} id={node.id}>
                  <ProjectNode project={nodeProject} sessions={nodeSessions} />
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
            {unorganized.length > 0 && (
              <div>
                {hasOrganized && (
                  <div className="text-[10px] text-muted-foreground/50 font-bold uppercase tracking-wider px-1 mb-1 flex items-center gap-2">
                    <span>Unorganized</span>
                    <span className="flex-1 h-px bg-border" />
                  </div>
                )}
                <div className="space-y-1">
                  {unorganized.map(({ project, sessions: projectSessions }, i) => {
                    // Insert separator before first ad-hoc-only group
                    const isAllAdHoc = projectSessions.every(s => s.capabilities?.includes('ad-hoc'))
                    const prevIsRegular =
                      i > 0 && !unorganized[i - 1].sessions.every(s => s.capabilities?.includes('ad-hoc'))
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
                          <ProjectNode project={project} sessions={projectSessions} />
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
        {showInactive && inactive.map(group => <InactiveProjectItem key={group[0].project} sessions={group} />)}
      </div>
    </MaybeProfiler>
  )
}
