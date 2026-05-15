import { Fzf } from 'fzf'
import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { getFrequencyMap } from '@/lib/conversation-frequency'
import { projectPath, type Session } from '@/lib/types'
import type { MergedItem } from './types'
import type { RegistryCommand } from './use-command-mode'

export interface SessionModeState {
  allConversations: Session[]
  mergedItems: MergedItem[]
  filteredSessions: Session[]
}

/**
 * Session-mode (no prefix) derivations. Sorts the session list (MRU top 2 +
 * frequency-weighted), runs Fzf over both sessions and the registry commands
 * with a small command-score penalty, and returns a merged list with live
 * sessions pinned above ended sessions and commands.
 */
export function useSessionMode(
  filter: string,
  isConversationMode: boolean,
  registryCommands: RegistryCommand[],
): SessionModeState {
  const sessions = useConversationsStore(state => state.sessions)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const sessionMru = useConversationsStore(state => state.sessionMru)
  const projectSettings = useConversationsStore(state => state.projectSettings)

  const freqMap = useMemo(() => getFrequencyMap(), [])

  const allConversations = useMemo(
    () => sortSessionsForPalette(sessions, sessionMru, freqMap),
    [sessions, sessionMru, freqMap],
  )

  const sessionFzf = useMemo(
    () =>
      new Fzf(allConversations, {
        selector: (s: Session) => {
          const ps = projectSettings[s.project]
          return `${projectPath(s.project)} ${ps?.label || ''} ${s.title || ''} ${s.agentName || ''} ${s.recap?.title || ''} ${s.id} ${s.model || ''} ${s.status}`
        },
        casing: 'case-insensitive',
      }),
    [allConversations, projectSettings],
  )

  const paletteCommandFzf = useMemo(
    () => new Fzf(registryCommands, { selector: c => `${c.label} ${c.id}`, casing: 'case-insensitive' }),
    [registryCommands],
  )

  const sessionSearchResults = useMemo(() => {
    if (!isConversationMode || !filter) return []
    return sessionFzf.find(filter).map(r => ({
      kind: 'session' as const,
      session: r.item,
      score: r.score,
      live: r.item.status !== 'ended',
    }))
  }, [isConversationMode, filter, sessionFzf])

  const commandSearchResults = useMemo(() => {
    if (!isConversationMode || !filter) return []
    // Penalty keeps commands below equally-scored sessions ("low score")
    const COMMAND_SCORE_PENALTY = 0.5
    return paletteCommandFzf.find(filter).map(r => ({
      kind: 'command' as const,
      command: r.item,
      score: r.score * COMMAND_SCORE_PENALTY,
      live: false,
    }))
  }, [isConversationMode, filter, paletteCommandFzf])

  const mergedItems: MergedItem[] = useMemo(() => {
    if (!isConversationMode) return []
    if (!filter) {
      return allConversations
        .filter(s => s.status !== 'ended' && s.id !== selectedConversationId)
        .map(s => ({ kind: 'session' as const, session: s, score: 0, live: true }))
    }
    const merged: MergedItem[] = [...sessionSearchResults, ...commandSearchResults]
    merged.sort((a, b) => {
      // Live sessions always above everything else (ended conversations + commands)
      if (a.live !== b.live) return a.live ? -1 : 1
      return b.score - a.score
    })
    return merged
  }, [isConversationMode, filter, allConversations, selectedConversationId, sessionSearchResults, commandSearchResults])

  const filteredSessions = useMemo(
    () =>
      mergedItems
        .filter((i): i is Extract<MergedItem, { kind: 'session' }> => i.kind === 'session')
        .map(i => i.session),
    [mergedItems],
  )

  return { allConversations, mergedItems, filteredSessions }
}

function sortSessionsForPalette(
  sessions: Session[],
  sessionMru: string[],
  freqMap: Record<string, { count: number }>,
): Session[] {
  const activeProjects = new Set(sessions.filter(s => s.status !== 'ended').map(s => s.project))
  const deduplicated = sessions.filter(s => s.status !== 'ended' || !activeProjects.has(s.project))
  const mruIndex = new Map(sessionMru.map((id, i) => [id, i]))
  return [...deduplicated].sort((a, b) => {
    const ai = mruIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const bi = mruIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER
    // Top 2 MRU spots are sacred (alt-tab behavior)
    const aTop = ai < 2
    const bTop = bi < 2
    if (aTop !== bTop) return aTop ? -1 : 1
    if (aTop && bTop) return ai - bi
    // Rest sorted by frequency (descending), then recency as tiebreaker
    const af = freqMap[a.project]?.count || 0
    const bf = freqMap[b.project]?.count || 0
    if (af !== bf) return bf - af
    return b.lastActivity - a.lastActivity
  })
}
