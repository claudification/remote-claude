/**
 * Pure ID-formatting + send-resolver helpers for channel.ts.
 *
 * Extracted so they can be unit-tested without spinning up the full handler
 * context (sessions store, address book, sockets, etc).
 *
 * Stable-ID rule (the whole point of this file):
 *   - `list_sessions` ALWAYS returns compound `project:session-slug` ids.
 *   - The bare `project` form is NEVER produced. This guarantees the id a
 *     caller sees today does not silently change shape tomorrow when a
 *     second session spawns at the same project.
 *
 * Resolver rule (what `send_message` accepts as `to`):
 *   - Compound `project:session-slug` -> resolves directly inside the project
 *   - Bare `project`                  -> accepted ONLY when exactly one
 *                                        candidate session exists in the project;
 *                                        rejected as ambiguous when 2+.
 */

import { extractProjectLabel, isSameProject } from '../../shared/project-uri'
import { slugify } from '../address-book'

export interface ConversationLike {
  id: string
  project: string
  title?: string
}

/**
 * Compute the per-conversation slug suffix used inside compound ids.
 * Falls back to a 6-char id slice when two conversations in the same project would
 * slug to the same value (so siblings stay disambiguable).
 */
export function computeConversationSlug(target: ConversationLike, siblingConversations: ConversationLike[]): string {
  const sessionSlug = slugify(target.title || target.id.slice(0, 8))
  const collides = siblingConversations.some(
    other => other.id !== target.id && slugify(other.title || other.id.slice(0, 8)) === sessionSlug,
  )
  return collides ? `${sessionSlug}-${target.id.slice(0, 6)}` : sessionSlug
}

/**
 * Always-compound local id: `project:session-slug`.
 *
 * Use for both `list_sessions` output and the from-id stamped on outgoing
 * messages so a recipient can replay it verbatim as `to`.
 */
export function computeLocalId(
  target: ConversationLike,
  projectSlug: string,
  siblingConversations: ConversationLike[],
): string {
  return `${projectSlug}:${computeConversationSlug(target, siblingConversations)}`
}

// ─── Send target resolution ─────────────────────────────────────────

export type ResolveSendTarget =
  | { kind: 'resolved'; session: ConversationLike }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; canonicalProject: string; candidates: ConversationLike[] }

export interface ResolveSendInput {
  /** The slug to the LEFT of `:` in the wire `to` -- a project slug. */
  projectSlug: string
  /** The slug to the RIGHT of `:`, or undefined for bare addressing. */
  sessionSlug: string | undefined
  /** All sessions registered at the resolved target project (live + inactive). */
  sessionsAtProject: ConversationLike[]
  /** The canonical project slug (label or dirname) to surface in error messages. */
  canonicalProject: string
  /** Predicate -- "is this conversation currently online?". Live count drives ambiguity. */
  isLive: (s: ConversationLike) => boolean
}

/**
 * Resolve a parsed `(projectSlug, sessionSlug?)` target against the conversation
 * registered at a given project. Returns the chosen session, a not-found marker,
 * or an ambiguous-bare error with the candidate compound ids the caller
 * should use instead.
 *
 * Bare-acceptance rule: a bare project address is allowed ONLY when there is
 * a unique candidate (preferring live over inactive). Multiple live sessions
 * = ambiguous. No live + multiple inactive = also ambiguous (caller must
 * pick one explicitly with the compound form).
 */
export function resolveSendTarget(input: ResolveSendInput): ResolveSendTarget {
  const { projectSlug, sessionSlug, sessionsAtProject, isLive } = input

  if (sessionSlug !== undefined) {
    const exact = sessionsAtProject.find(s => slugify(s.title || s.id.slice(0, 8)) === sessionSlug)
    if (exact) return { kind: 'resolved', session: exact }
    const prefix = sessionsAtProject.find(s => slugify(s.title || s.id.slice(0, 8)).startsWith(sessionSlug))
    if (prefix) return { kind: 'resolved', session: prefix }
    return { kind: 'not_found' }
  }

  // Bare addressing.
  // First: exact session-title match (a conversation named "arr" beats project-level dispatch).
  const titleMatch = sessionsAtProject.find(s => slugify(s.title || s.id.slice(0, 8)) === projectSlug)
  if (titleMatch) return { kind: 'resolved', session: titleMatch }

  const live = sessionsAtProject.filter(isLive)
  if (live.length === 1) return { kind: 'resolved', session: live[0] }
  if (live.length > 1) {
    return { kind: 'ambiguous', canonicalProject: input.canonicalProject, candidates: live }
  }
  // No live -- fall back to inactive, but only if unambiguous.
  if (sessionsAtProject.length === 1) return { kind: 'resolved', session: sessionsAtProject[0] }
  if (sessionsAtProject.length > 1) {
    return { kind: 'ambiguous', canonicalProject: input.canonicalProject, candidates: sessionsAtProject }
  }
  return { kind: 'not_found' }
}

/**
 * Format the user-facing ambiguity error with the compound ids the caller
 * should retry with. Lives here (not in the handler) so it stays in sync
 * with the resolver and is testable without a context.
 */
export function formatAmbiguityError(canonicalProject: string, candidates: ConversationLike[]): string {
  const siblingConversations = candidates
  const ids = candidates.map(s => `${canonicalProject}:${computeConversationSlug(s, siblingConversations)}`).join(', ')
  return `Ambiguous target: ${candidates.length} sessions at "${canonicalProject}". Use compound address: ${ids}`
}

// ─── Shared target resolution ──────────────────────────────────────

export type ResolveConversationResult =
  | { kind: 'resolved'; session: ConversationLike }
  | { kind: 'not_found'; error: string }
  | { kind: 'ambiguous'; error: string }

export interface ResolveConversationDeps {
  callerConversationId: string | undefined
  getAllConversations: () => ConversationLike[]
  getConversation: (id: string) => ConversationLike | undefined
  findConversationByConversationId: (id: string) => ConversationLike | undefined
  getActiveConversationCount: (id: string) => number
  getProjectSettings: (project: string) => { label?: string } | null
  addressBook: {
    resolve: (fromProject: string, slug: string) => string | undefined
    getOrAssign: (fromProject: string, toProject: string, name: string) => string
  }
  callerProject: string | undefined
}

/**
 * Resolve a target ID (compound "project:session-slug", bare project slug,
 * or raw internal session/conversation ID) to a conversation.
 *
 * Used by session_control, channel_restart, channel_configure, and
 * channel_send to consistently handle the compound ID format returned
 * by list_sessions.
 */
export function resolveConversationTarget(targetId: string, deps: ResolveConversationDeps): ResolveConversationResult {
  const colonIdx = targetId.indexOf(':')
  const hasCompound = colonIdx >= 0
  const projectSlug = hasCompound ? targetId.slice(0, colonIdx) : targetId
  const sessionSlug = hasCompound ? targetId.slice(colonIdx + 1) : undefined

  let targetProject = deps.callerProject ? deps.addressBook.resolve(deps.callerProject, projectSlug) : undefined

  if (!targetProject && deps.callerProject) {
    for (const s of deps.getAllConversations()) {
      if (s.id === deps.callerConversationId) continue
      const projSettings = deps.getProjectSettings(s.project)
      const projectName = projSettings?.label || extractProjectLabel(s.project)
      deps.addressBook.getOrAssign(deps.callerProject, s.project, projectName)
    }
    targetProject = deps.addressBook.resolve(deps.callerProject, projectSlug)
  }

  if (targetProject) {
    const sessionsAtProject = deps.getAllConversations().filter(s => isSameProject(s.project, targetProject))
    const projSettings = deps.getProjectSettings(targetProject)
    const canonicalProject = slugify(projSettings?.label || extractProjectLabel(targetProject))
    const resolved = resolveSendTarget({
      projectSlug,
      sessionSlug,
      sessionsAtProject,
      canonicalProject,
      isLive: s => deps.getActiveConversationCount(s.id) > 0,
    })
    if (resolved.kind === 'ambiguous') {
      return { kind: 'ambiguous', error: formatAmbiguityError(resolved.canonicalProject, resolved.candidates) }
    }
    if (resolved.kind === 'resolved') {
      return { kind: 'resolved', session: resolved.session }
    }
    return { kind: 'not_found', error: `Session not found at project "${canonicalProject}"` }
  }

  // Fallback: try raw internal ID / conversation ID
  const fallback = deps.findConversationByConversationId(targetId) || deps.getConversation(targetId)
  if (fallback) return { kind: 'resolved', session: fallback }
  return { kind: 'not_found', error: 'Target not connected. Use list_sessions to find current sessions.' }
}
