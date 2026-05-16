import { Fzf } from 'fzf'
import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { getFrequencyMap } from '@/lib/conversation-frequency'
import { type Conversation, projectPath } from '@/lib/types'
import type { MergedItem } from './types'
import type { RegistryCommand } from './use-command-mode'

export interface ConversationModeState {
  allConversations: Conversation[]
  mergedItems: MergedItem[]
  filteredConversations: Conversation[]
}

/**
 * Conversation-mode (no prefix) derivations. Sorts the conversation list (MRU top 2 +
 * frequency-weighted), runs Fzf over both conversations and the registry commands
 * with a small command-score penalty, and returns a merged list with live
 * conversations pinned above ended conversations and commands.
 */
export function useConversationMode(
  filter: string,
  isConversationMode: boolean,
  registryCommands: RegistryCommand[],
): ConversationModeState {
  const conversations = useConversationsStore(state => state.conversations)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const conversationMru = useConversationsStore(state => state.conversationMru)
  const projectSettings = useConversationsStore(state => state.projectSettings)

  const freqMap = useMemo(() => getFrequencyMap(), [])

  const allConversations = useMemo(
    () => sortConversationsForPalette(conversations, conversationMru, freqMap),
    [conversations, conversationMru, freqMap],
  )

  const conversationFzf = useMemo(
    () =>
      new Fzf(allConversations, {
        selector: (s: Conversation) => {
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

  const conversationSearchResults = useMemo(() => {
    if (!isConversationMode || !filter) return []
    return conversationFzf.find(filter).map(r => ({
      kind: 'conversation' as const,
      conversation: r.item,
      score: r.score,
      live: r.item.status !== 'ended',
    }))
  }, [isConversationMode, filter, conversationFzf])

  const commandSearchResults = useMemo(() => {
    if (!isConversationMode || !filter) return []
    // Penalty keeps commands below equally-scored conversations ("low score")
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
        .map(s => ({ kind: 'conversation' as const, conversation: s, score: 0, live: true }))
    }
    const merged: MergedItem[] = [...conversationSearchResults, ...commandSearchResults]
    merged.sort((a, b) => {
      // Live conversations always above everything else (ended conversations + commands)
      if (a.live !== b.live) return a.live ? -1 : 1
      return b.score - a.score
    })
    return merged
  }, [
    isConversationMode,
    filter,
    allConversations,
    selectedConversationId,
    conversationSearchResults,
    commandSearchResults,
  ])

  const filteredConversations = useMemo(
    () =>
      mergedItems
        .filter((i): i is Extract<MergedItem, { kind: 'conversation' }> => i.kind === 'conversation')
        .map(i => i.conversation),
    [mergedItems],
  )

  return { allConversations, mergedItems, filteredConversations }
}

function sortConversationsForPalette(
  conversations: Conversation[],
  conversationMru: string[],
  freqMap: Record<string, { count: number }>,
): Conversation[] {
  const activeProjects = new Set(conversations.filter(s => s.status !== 'ended').map(s => s.project))
  const deduplicated = conversations.filter(s => s.status !== 'ended' || !activeProjects.has(s.project))
  const mruIndex = new Map(conversationMru.map((id, i) => [id, i]))
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
