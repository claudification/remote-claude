import { useCallback, useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { setConversationTab } from '@/lib/ui-state'
import type { Tab } from './conversation-tabs'

export function useConversationTab(selectedConversationId: string | null, conversationStatus: string | undefined) {
  const [activeTab, setActiveTab] = useState<Tab>('transcript')
  const [follow, setFollow] = useState(true)
  const [infoExpanded, setInfoExpanded] = useState(false)
  const [conversationTarget, setConversationTarget] = useState<{
    projectA: string
    projectB: string
    nameA: string
    nameB: string
  } | null>(null)
  const disableFollow = useCallback(() => setFollow(false), [])
  const enableFollow = useCallback(() => setFollow(true), [])

  const requestedTab = useConversationsStore(state => state.requestedTab)
  const requestedTabSeq = useConversationsStore(state => state.requestedTabSeq)

  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedConversationId is the trigger dep
  useEffect(() => {
    setFollow(true)
    setConversationTarget(null)
  }, [selectedConversationId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: requestedTabSeq is a counter dep key
  useEffect(() => {
    if (requestedTab) setActiveTab(requestedTab as Tab)
  }, [requestedTab, requestedTabSeq])

  useEffect(() => {
    if (conversationStatus === 'ended' && (activeTab === 'files' || activeTab === 'project')) {
      setActiveTab('transcript')
    }
  }, [conversationStatus, activeTab])

  useEffect(() => {
    if (selectedConversationId) setConversationTab(selectedConversationId, activeTab)
  }, [selectedConversationId, activeTab])

  return {
    activeTab,
    setActiveTab,
    follow,
    setFollow,
    disableFollow,
    enableFollow,
    infoExpanded,
    setInfoExpanded,
    conversationTarget,
    setConversationTarget,
  }
}
