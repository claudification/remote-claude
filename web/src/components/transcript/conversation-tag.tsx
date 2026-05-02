/**
 * SessionTag - Clickable session name badge with hover tooltip showing project/status.
 * Shared by send_message (tool-line) and received inter-session messages (group-view).
 */

import { buildSessionsById, useConversationsStore } from '@/hooks/use-conversations'
import type { Session } from '@/lib/types'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'project'
  )
}

/** Strip project prefix from address-book style slugs (e.g. "rclaude:dapper-pretzel" -> "dapper-pretzel"). */
function stripProjectPrefix(slug: string): string {
  const colonIdx = slug.indexOf(':')
  return colonIdx >= 0 ? slug.slice(colonIdx + 1) : slug
}

/** Find a session matching an address book slug (best-effort client-side match). */
function findSessionBySlug(slug: string) {
  const { sessions, projectSettings } = useConversationsStore.getState()
  const normalizedSlug = slug.toLowerCase()
  for (const s of sessions) {
    const ps = projectSettings[s.project]
    if (ps?.label && slugify(ps.label) === normalizedSlug) return s
    if (s.title && slugify(s.title) === normalizedSlug) return s
    const dirname = extractProjectLabel(s.project)
    if (dirname && slugify(dirname) === normalizedSlug) return s
  }
  return undefined
}

/** Resolve a session by ID or slug and compute the display name. */
function resolveSessionDisplay(idOrSlug: string, fallbackId?: string) {
  const { sessionsById, projectSettings } = useConversationsStore.getState()
  const bare = stripProjectPrefix(idOrSlug)
  const session =
    sessionsById[idOrSlug] ||
    sessionsById[bare] ||
    (fallbackId ? sessionsById[fallbackId] : undefined) ||
    findSessionBySlug(bare) ||
    findSessionBySlug(idOrSlug)
  const projLabel = session?.project ? projectSettings[session.project]?.label : undefined
  const title = session?.title
  const displayName =
    projLabel && title
      ? `${projLabel} :: ${title}`
      : title || projLabel || (session?.project ? extractProjectLabel(session.project) : '') || bare
  return { session, projLabel, title, displayName }
}

function showToast(title: string, body: string, variant = 'warning') {
  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail: { title, body, variant } }))
}

/** Inject a fetched session overview into the Zustand store so it becomes navigable. */
function injectSession(overview: Record<string, unknown>) {
  const partial: Session = {
    id: overview.id as string,
    project: overview.project as string,
    model: overview.model as string,
    status: (overview.status as Session['status']) || 'ended',
    ccSessionIds: (overview.ccSessionIds as string[]) || [],
    startedAt: overview.startedAt as number,
    lastActivity: overview.lastActivity as number,
    eventCount: (overview.eventCount as number) || 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
    archivedTaskCount: 0,
    archivedTasks: [],
    runningBgTaskCount: 0,
    bgTasks: [],
    monitors: [],
    runningMonitorCount: 0,
    teammates: [],
    summary: overview.summary as string | undefined,
    title: overview.title as string | undefined,
    agentName: overview.agentName as string | undefined,
  }
  useConversationsStore.setState(state => {
    if (state.sessionsById[partial.id]) return state
    const sessions = [...state.sessions, partial]
    return { sessions, sessionsById: buildSessionsById(sessions) }
  })
  return partial.id
}

/** Try to fetch a session from the server by UUID or slug. Returns the session ID on success. */
async function fetchAndInjectSession(resolvedId?: string, slug?: string): Promise<string | null> {
  const attempts: string[] = []
  if (resolvedId) attempts.push(`/conversations/${resolvedId}`)
  if (slug) attempts.push(`/conversations/by-slug/${slug}`)

  for (const url of attempts) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const data = await res.json()
      if (data?.id) return injectSession(data)
    } catch {
      /* network error, try next */
    }
  }
  return null
}

interface SessionTagProps {
  /** Session ID or slug to resolve */
  idOrSlug: string
  /** Resolved session UUID (from tool result) -- used as fallback when slug doesn't match */
  resolvedId?: string
  /** Text size class, defaults to text-xs */
  className?: string
}

export function SessionTag({ idOrSlug, resolvedId, className }: SessionTagProps) {
  const { session, displayName } = resolveSessionDisplay(idOrSlug, resolvedId)
  const resolvedPath = session?.project ? projectPath(session.project) : undefined
  const status = session?.status
  const isEnded = status === 'ended'

  const handleClick = () => {
    if (session) {
      haptic('tap')
      useConversationsStore.getState().selectConversation(session.id)
      return
    }
    haptic('tap')
    const bare = stripProjectPrefix(idOrSlug)
    fetchAndInjectSession(resolvedId, bare).then(id => {
      if (id) {
        useConversationsStore.getState().selectConversation(id)
      } else {
        haptic('error')
        showToast('Session not found', `Could not find session "${bare}" on the server.`)
      }
    })
  }

  return (
    <span className="relative group/stag inline-block">
      <button
        type="button"
        className={cn(
          'font-bold hover:underline',
          session ? 'cursor-pointer' : 'cursor-help',
          isEnded ? 'text-teal-400/50 hover:text-teal-400/70' : 'text-teal-400 hover:text-teal-300',
          !session && 'text-teal-400/40 hover:text-teal-400/60',
          className,
        )}
        onClick={handleClick}
      >
        {displayName}
        {isEnded && <span className="ml-1 text-[9px] text-zinc-500 font-normal">(ended)</span>}
      </button>
      {/* Hover tooltip */}
      <span
        className={cn(
          'pointer-events-none absolute bottom-full left-0 mb-1.5 z-50',
          'hidden group-hover/stag:flex flex-col gap-0.5',
          'rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 shadow-lg',
          'text-[10px] font-mono whitespace-nowrap',
        )}
      >
        {resolvedPath && <span className="text-zinc-300">{resolvedPath}</span>}
        <span className={cn('text-zinc-500', isEnded && 'text-zinc-600')}>{status ?? 'unknown'}</span>
        {(session?.id ?? idOrSlug) && (
          <span className="text-zinc-600">
            <span className="text-zinc-700">@</span> {session?.id ?? idOrSlug}
          </span>
        )}
        {!session && <span className="text-amber-500/80">click to search server</span>}
      </span>
    </span>
  )
}
