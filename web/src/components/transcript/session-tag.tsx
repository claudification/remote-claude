/**
 * SessionTag - Clickable session name badge with hover tooltip showing cwd/status.
 * Shared by send_message (tool-line) and received inter-session messages (group-view).
 */

import { useSessionsStore } from '@/hooks/use-sessions'
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

/** Find a session matching an address book slug (best-effort client-side match). */
function findSessionBySlug(slug: string) {
  const { sessions, projectSettings } = useSessionsStore.getState()
  const normalizedSlug = slug.toLowerCase()
  for (const s of sessions) {
    const ps = projectSettings[s.cwd]
    if (ps?.label && slugify(ps.label) === normalizedSlug) return s
    if (s.title && slugify(s.title) === normalizedSlug) return s
    const dirname = s.cwd?.split('/').pop() || ''
    if (dirname && slugify(dirname) === normalizedSlug) return s
  }
  return undefined
}

/** Resolve a session by ID or slug and compute the display name. */
function resolveSessionDisplay(idOrSlug: string) {
  const { sessionsById, projectSettings } = useSessionsStore.getState()
  const session = sessionsById[idOrSlug] || findSessionBySlug(idOrSlug)
  const projLabel = session?.cwd ? projectSettings[session.cwd]?.label : undefined
  const title = session?.title
  const displayName =
    projLabel && title ? `${projLabel} :: ${title}` : title || projLabel || session?.cwd?.split('/').pop() || idOrSlug
  return { session, projLabel, title, displayName }
}

interface SessionTagProps {
  /** Session ID or slug to resolve */
  idOrSlug: string
  /** Text size class, defaults to text-xs */
  className?: string
}

export function SessionTag({ idOrSlug, className }: SessionTagProps) {
  const { session, displayName } = resolveSessionDisplay(idOrSlug)
  const cwd = session?.cwd
  const status = session?.status

  const handleClick = () => {
    if (session) {
      haptic('tap')
      useSessionsStore.getState().selectSession(session.id)
    }
  }

  return (
    <span className="relative group/stag inline-block">
      <button
        type="button"
        className={cn('font-bold text-teal-400 hover:text-teal-300 hover:underline', className)}
        onClick={handleClick}
      >
        {displayName}
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
        {cwd && <span className="text-zinc-300">{cwd}</span>}
        <span className="text-zinc-500">{status ?? 'unknown'}</span>
        {(session?.id ?? idOrSlug) && (
          <span className="text-zinc-600">
            <span className="text-zinc-700">@</span> {session?.id ?? idOrSlug}
          </span>
        )}
      </span>
    </span>
  )
}
