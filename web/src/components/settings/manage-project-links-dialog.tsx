import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrderGroup } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'

const API_BASE = `${window.location.protocol}//${window.location.host}/api`

interface ProjectItem {
  id: number
  scope: string
  slug: string
  label: string | null
  project_uri: string
}

interface LinkItem {
  projectA: string
  projectB: string
}

function projectDisplayName(p: ProjectItem): string {
  return p.label || p.project_uri.split('/').pop() || p.slug
}

function displayNameFromUri(uri: string): string {
  return uri.split('/').pop() || uri
}

function normalizeUri(uri: string): string {
  if (!uri.includes('://')) return uri
  const idx = uri.indexOf('://')
  const scheme = uri.slice(0, idx).toLowerCase()
  let rest = uri.slice(idx + 3)
  const hashIdx = rest.indexOf('#')
  if (hashIdx >= 0) rest = rest.slice(0, hashIdx)
  if (rest.endsWith('/')) rest = rest.slice(0, -1)
  const slashIdx = rest.indexOf('/')
  let authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest
  const path = slashIdx >= 0 ? rest.slice(slashIdx) : ''
  if (scheme === 'claude' && !authority) authority = 'default'
  return `${scheme}://${authority}${path}`
}

function uriMatches(a: string, b: string): boolean {
  if (a === b) return true
  return normalizeUri(a) === normalizeUri(b)
}

let _openManageLinks: ((projectUri?: string) => void) | null = null

export function openManageProjectLinks(projectUri?: string): void {
  _openManageLinks?.(projectUri)
}

export function ManageProjectLinksDialog() {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [links, setLinks] = useState<LinkItem[]>([])
  const [focusProject, setFocusProject] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [toggling, setToggling] = useState<Set<string>>(new Set())
  const pinned = useRef(false)
  const rawProjectOrder = useConversationsStore(s => s.projectOrder)
  const projectSettings = useConversationsStore(s => s.projectSettings)

  _openManageLinks = useCallback((projectUri?: string) => {
    pinned.current = !!projectUri
    setFocusProject(projectUri || null)
    setOpen(true)
    setFilter('')
  }, [])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [projRes, linksRes] = await Promise.all([fetch(`${API_BASE}/projects`), fetch(`${API_BASE}/links`)])
      if (projRes.ok) {
        const data = (await projRes.json()) as { projects: ProjectItem[] }
        setProjects(data.projects)
      }
      if (linksRes.ok) {
        const data = (await linksRes.json()) as { links: LinkItem[] }
        setLinks(data.links)
      }
    } catch {
      // network error
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) fetchData()
  }, [open, fetchData])

  useEffect(() => {
    if (!open || projects.length === 0) return
    if (focusProject) {
      const match = projects.find(p => uriMatches(p.project_uri, focusProject))
      if (match && match.project_uri !== focusProject) {
        setFocusProject(match.project_uri)
      }
    } else if (!pinned.current) {
      setFocusProject(projects[0].project_uri)
    }
  }, [open, projects, focusProject])

  function handleClose() {
    setOpen(false)
    setFocusProject(null)
    setFilter('')
    pinned.current = false
  }

  function isLinkedTo(targetUri: string): boolean {
    if (!focusProject) return false
    return links.some(
      l =>
        (uriMatches(l.projectA, focusProject) && uriMatches(l.projectB, targetUri)) ||
        (uriMatches(l.projectB, focusProject) && uriMatches(l.projectA, targetUri)),
    )
  }

  const otherProjects = useMemo(() => {
    const lf = filter.toLowerCase()
    return projects
      .filter(p => !focusProject || !uriMatches(p.project_uri, focusProject))
      .filter(p => {
        if (!lf) return true
        const name = projectDisplayName(p).toLowerCase()
        const settingsLabel = projectSettings[p.project_uri]?.label?.toLowerCase()
        return name.includes(lf) || p.slug.includes(lf) || (settingsLabel && settingsLabel.includes(lf))
      })
  }, [projects, focusProject, filter, projectSettings])

  const linkedCount = useMemo(() => {
    if (!focusProject) return 0
    return projects.filter(p => !uriMatches(p.project_uri, focusProject) && isLinkedTo(p.project_uri)).length
  }, [focusProject, projects, links])

  const projectOrder = rawProjectOrder?.tree ?? []

  const groupedOtherProjects = useMemo(() => {
    const projectMap = new Map<string, ProjectItem>()
    for (const p of otherProjects) {
      projectMap.set(p.project_uri, p)
    }

    const groups: Array<{ name: string; projects: ProjectItem[] }> = []
    const claimed = new Set<string>()

    for (const node of projectOrder) {
      if (node.type !== 'group') continue
      const group = node as ProjectOrderGroup
      const members: ProjectItem[] = []
      for (const child of group.children) {
        if (child.type !== 'project') continue
        const match = findProjectByOrderId(child.id, projectMap)
        if (match) {
          members.push(match)
          claimed.add(match.project_uri)
        }
      }
      if (members.length > 0) groups.push({ name: group.name, projects: members })
    }

    const ungrouped = otherProjects.filter(p => !claimed.has(p.project_uri))
    if (ungrouped.length > 0) groups.push({ name: '', projects: ungrouped })

    return groups
  }, [otherProjects, projectOrder])

  async function toggleLink(targetUri: string) {
    if (!focusProject || toggling.has(targetUri)) return
    haptic('tap')

    setToggling(prev => new Set(prev).add(targetUri))
    const linked = isLinkedTo(targetUri)

    try {
      if (linked) {
        await fetch(`${API_BASE}/links`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectA: focusProject, projectB: targetUri }),
        })
      } else {
        await fetch(`${API_BASE}/links`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectA: focusProject, projectB: targetUri }),
        })
      }
      await fetchData()
    } catch {
      await fetchData()
    } finally {
      setToggling(prev => {
        const next = new Set(prev)
        next.delete(targetUri)
        return next
      })
    }
  }

  const focusProjectObj = projects.find(p => focusProject && uriMatches(p.project_uri, focusProject))
  const focusName = focusProjectObj ? projectDisplayName(focusProjectObj) : displayNameFromUri(focusProject || '')

  return (
    <Dialog open={open} onOpenChange={o => !o && handleClose()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 flex flex-col gap-3 min-h-0 max-h-[calc(85vh-2rem)]">
          {loading && projects.length === 0 ? (
            <>
              <DialogTitle className="text-sm font-bold font-mono">MANAGE PROJECT LINKS</DialogTitle>
              <div className="text-xs text-muted-foreground font-mono py-4">Loading...</div>
            </>
          ) : projects.length < 2 ? (
            <>
              <DialogTitle className="text-sm font-bold font-mono">MANAGE PROJECT LINKS</DialogTitle>
              <div className="text-xs text-muted-foreground font-mono py-4">
                Need at least 2 projects to create links.
              </div>
            </>
          ) : (
            <>
              {pinned.current ? (
                <DialogTitle className="text-sm font-bold font-mono truncate">
                  LINKS: <span className="text-teal-400">{focusName}</span>
                </DialogTitle>
              ) : (
                <>
                  <DialogTitle className="text-sm font-bold font-mono">MANAGE PROJECT LINKS</DialogTitle>
                  <select
                    value={focusProject || ''}
                    onChange={e => {
                      setFocusProject(e.target.value)
                      haptic('tick')
                    }}
                    className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    {projects.map(p => (
                      <option key={p.project_uri} value={p.project_uri}>
                        {projectDisplayName(p)}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <input
                type="text"
                placeholder="Filter projects..."
                value={filter}
                onChange={e => setFilter(e.target.value)}
                className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />

              <div className="overflow-y-auto flex-1 min-h-0 -mx-1 px-1">
                {otherProjects.length === 0 ? (
                  <div className="text-xs text-muted-foreground font-mono py-2">
                    {filter ? 'No matching projects.' : 'No other projects.'}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {groupedOtherProjects.map(group => (
                      <div key={group.name || '__ungrouped'}>
                        {group.name && (
                          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-2 pb-0.5 pt-1">
                            {group.name}
                          </div>
                        )}
                        <div className="space-y-0.5">
                          {group.projects.map(p => (
                            <ProjectCheckboxRow
                              key={p.project_uri}
                              project={p}
                              linked={isLinkedTo(p.project_uri)}
                              busy={toggling.has(p.project_uri)}
                              onToggle={() => toggleLink(p.project_uri)}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {linkedCount > 0 && (
                <div className="text-[10px] text-muted-foreground font-mono pt-1 border-t border-border">
                  {linkedCount} linked project{linkedCount !== 1 ? 's' : ''}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ProjectCheckboxRow({
  project,
  linked,
  busy,
  onToggle,
}: {
  project: ProjectItem
  linked: boolean
  busy: boolean
  onToggle: () => void
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-2.5 px-2 py-1.5 rounded cursor-pointer',
        'hover:bg-muted/30 transition-colors',
        busy && 'opacity-50 pointer-events-none',
      )}
    >
      <Checkbox checked={linked} onCheckedChange={onToggle} disabled={busy} />
      <span className={cn('text-xs font-mono truncate', linked ? 'text-teal-400' : 'text-foreground')}>
        {projectDisplayName(project)}
      </span>
    </label>
  )
}

function findProjectByOrderId(orderId: string, projectMap: Map<string, ProjectItem>): ProjectItem | undefined {
  const direct = projectMap.get(orderId)
  if (direct) return direct
  for (const [uri, p] of projectMap) {
    if (uriMatches(uri, orderId)) return p
  }
  return undefined
}
