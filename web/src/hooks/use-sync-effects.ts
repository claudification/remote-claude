import { useCallback, useEffect, useRef } from 'react'
import {
  fetchConversationEvents,
  fetchGlobalSettings,
  fetchProjectOrder,
  fetchProjectSettings,
  fetchServerCapabilities,
  fetchTranscript,
  saveProjectOrder,
  useConversationsStore,
  wsSend,
} from '@/hooks/use-conversations'
import { useWebSocket } from '@/hooks/use-websocket'
import { setChordTimeout } from '@/lib/key-layers'
import { fetchModelDb } from '@/lib/model-db'
import { flattenProjectOrderTree, projectOrderTreesEqual } from '@/lib/types'

// Fetch sidebar metadata (project settings, capabilities, global settings, session order).
// Called on mount AND on reconnect/visibility-restore to catch renames, reorders, etc.
function useSidebarMetadata() {
  const fetchSidebarMetadata = useCallback(async () => {
    const [settings, capabilities, globalSettings, order] = await Promise.all([
      fetchProjectSettings(),
      fetchServerCapabilities(),
      fetchGlobalSettings(),
      fetchProjectOrder(),
      fetchModelDb(),
    ])
    const flatTree = flattenProjectOrderTree(order.tree)
    const flatOrder = { ...order, tree: flatTree }
    useConversationsStore.setState({
      projectSettings: settings,
      serverCapabilities: capabilities,
      globalSettings,
      projectOrder: flatOrder,
    })
    if (!projectOrderTreesEqual(order.tree, flatTree)) saveProjectOrder(flatOrder)
  }, [])

  useEffect(() => {
    fetchSidebarMetadata()
  }, [fetchSidebarMetadata])

  return fetchSidebarMetadata
}

function useConversationFetcher() {
  const setEvents = useConversationsStore(s => s.setEvents)
  const setTranscript = useConversationsStore(s => s.setTranscript)
  const fetchedAtRef = useRef<Record<string, number>>({})

  const fetchConversationData = useCallback(
    (convId: string, reason?: string) => {
      const now = Date.now()
      const lastFetch = fetchedAtRef.current[convId] || 0
      const elapsed = now - lastFetch
      if (elapsed < 2000) {
        console.log(`[sync] SKIP fetch ${convId.slice(0, 8)} (${reason || '?'}) - fetched ${elapsed}ms ago`)
        return
      }
      const cachedCount = useConversationsStore.getState().transcripts[convId]?.length ?? 0
      console.log(
        `[sync] FETCH ${convId.slice(0, 8)} (${reason || '?'}) cached=${cachedCount} lastFetch=${lastFetch ? `${elapsed}ms ago` : 'never'}`,
      )
      fetchedAtRef.current[convId] = now
      Promise.all([fetchConversationEvents(convId), fetchTranscript(convId)]).then(([events, transcript]) => {
        console.log(
          `[sync] GOT ${convId.slice(0, 8)}: events=${events.length} transcript=${transcript?.entries.length ?? 'null'} lastSeq=${transcript?.lastSeq ?? '-'} (was ${cachedCount})`,
        )
        setEvents(convId, events)
        if (transcript) setTranscript(convId, transcript.entries)
      })
    },
    [setEvents, setTranscript],
  )

  function resetFetchedAt() {
    fetchedAtRef.current = {}
  }

  return { fetchConversationData, resetFetchedAt }
}

function useVisibilitySync(fetchSidebarMetadata: () => Promise<void>) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - reads store state inline, fetchSidebarMetadata is stable
  useEffect(() => {
    let hiddenAt = 0
    function handleVisibility() {
      if (document.hidden) {
        hiddenAt = Date.now()
        console.log('[sync] hidden')
      } else if (hiddenAt) {
        const elapsed = Date.now() - hiddenAt
        hiddenAt = 0
        const { syncEpoch, syncSeq, lastAppliedTranscriptSeq } = useConversationsStore.getState()
        const transcriptSeqs: Record<string, number> = {}
        for (const [sid, seq] of Object.entries(lastAppliedTranscriptSeq)) {
          if (seq > 0) transcriptSeqs[sid] = seq
        }
        console.log(
          `[sync] restored after ${(elapsed / 1000).toFixed(1)}s - sending sync_check (epoch=${syncEpoch.slice(0, 8)} seq=${syncSeq} transcripts=${Object.keys(transcriptSeqs).length})`,
        )
        wsSend('sync_check', { epoch: syncEpoch, lastSeq: syncSeq, transcripts: transcriptSeqs })
        if (elapsed > 30_000) {
          console.log(`[sync] refetch sidebar metadata after ${(elapsed / 1000).toFixed(0)}s background`)
          fetchSidebarMetadata()
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])
}

function useConnectSeqSync(
  fetchSidebarMetadata: () => Promise<void>,
  fetchConversationData: (convId: string, reason?: string) => void,
  resetFetchedAt: () => void,
) {
  const isConnected = useConversationsStore(state => state.isConnected)
  const connectSeq = useConversationsStore(state => state.connectSeq)

  // biome-ignore lint/correctness/useExhaustiveDependencies: isConnected intentionally omitted - connectSeq only bumps while connected
  useEffect(() => {
    if (!isConnected) return
    const sid = useConversationsStore.getState().selectedConversationId
    console.log(
      `[sync] connectSeq=${connectSeq} - refresh sessions + sidebar metadata, re-fetch ${sid?.slice(0, 8) || 'none'}`,
    )
    wsSend('refresh_sessions')
    // Hydrate the recap-jobs widget on every connect so the bottom-of-sidebar
    // widget reflects active + recent jobs the broker is tracking. Limit to
    // the most recent slice -- the widget filters down to active/recent on the
    // client; the rest live in the history modal (Phase 10).
    wsSend('recap_list', { limit: 50, status: ['queued', 'gathering', 'rendering', 'failed', 'done'] })
    fetchSidebarMetadata()
    resetFetchedAt()
    if (sid) fetchConversationData(sid, 'reconnect')
  }, [connectSeq, fetchConversationData, fetchSidebarMetadata]) // eslint-disable-line react-hooks/exhaustive-deps

  return { isConnected }
}

function useConversationSwitchFetch(
  isConnected: boolean,
  fetchConversationData: (convId: string, reason?: string) => void,
) {
  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)

  // biome-ignore lint/correctness/useExhaustiveDependencies: isConnected and fetchConversationData intentionally omitted - only re-run on conversation switch
  useEffect(() => {
    if (!selectedConversationId || !isConnected) return
    const { transcripts, events } = useConversationsStore.getState()
    const cachedTranscript = transcripts[selectedConversationId]?.length ?? 0
    const cachedEvents = events[selectedConversationId]?.length ?? 0
    if (cachedTranscript > 0) {
      console.log(
        `[sync] HIT ${selectedConversationId.slice(0, 8)}: transcript=${cachedTranscript} events=${cachedEvents} (no fetch, WS sub alive)`,
      )
    } else {
      console.log(`[sync] MISS ${selectedConversationId.slice(0, 8)}: no cached transcript, fetching full`)
      fetchConversationData(selectedConversationId, 'session-switch-empty')
    }
  }, [selectedConversationId]) // eslint-disable-line react-hooks/exhaustive-deps
}

function useLifoCacheTimeout() {
  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const cacheTimestamps = useRef<Record<string, number>>({})

  useEffect(() => {
    if (selectedConversationId) cacheTimestamps.current[selectedConversationId] = Date.now()
  }, [selectedConversationId])

  useEffect(() => {
    const interval = setInterval(() => {
      const { sessionCacheTimeout } = useConversationsStore.getState().controlPanelPrefs
      if (sessionCacheTimeout <= 0) return
      const now = Date.now()
      const timeoutMs = sessionCacheTimeout * 60_000
      const selected = useConversationsStore.getState().selectedConversationId
      const transcripts = useConversationsStore.getState().transcripts
      let evicted = false
      for (const sid of Object.keys(transcripts)) {
        if (sid === selected) continue
        const lastViewed = cacheTimestamps.current[sid] || 0
        if (now - lastViewed > timeoutMs) {
          delete cacheTimestamps.current[sid]
          evicted = true
        }
      }
      if (evicted) {
        useConversationsStore.setState(state => {
          const kept = new Set(state.sessionMru.slice(0, state.controlPanelPrefs.sessionCacheSize))
          if (state.selectedConversationId) kept.add(state.selectedConversationId)
          const events = { ...state.events }
          const transcripts = { ...state.transcripts }
          for (const sid of Object.keys(transcripts)) {
            if (!kept.has(sid)) {
              delete events[sid]
              delete transcripts[sid]
            }
          }
          return { events, transcripts }
        })
      }
    }, 60_000)
    return () => clearInterval(interval)
  }, [])
}

function useAuthCheck() {
  useEffect(() => {
    const AUTH_CHECK_INTERVAL = 4 * 60 * 60 * 1000
    const check = async () => {
      try {
        const res = await fetch('/auth/status')
        if (res.ok) {
          const data = await res.json()
          if (!data.authenticated) {
            useConversationsStore.getState().setAuthExpired(true)
          }
        }
      } catch {}
    }
    const timer = setInterval(check, AUTH_CHECK_INTERVAL)
    return () => clearInterval(timer)
  }, [])
}

function useChordTimeoutSync() {
  const chordTimeoutMs = useConversationsStore(s => s.controlPanelPrefs.chordTimeoutMs)
  useEffect(() => {
    setChordTimeout(chordTimeoutMs)
  }, [chordTimeoutMs])
}

export function useSyncEffects() {
  useWebSocket() // must be called before sync effects that depend on WS state
  const fetchSidebarMetadata = useSidebarMetadata()
  const { fetchConversationData, resetFetchedAt } = useConversationFetcher()
  useVisibilitySync(fetchSidebarMetadata)
  const { isConnected } = useConnectSeqSync(fetchSidebarMetadata, fetchConversationData, resetFetchedAt)
  useConversationSwitchFetch(isConnected, fetchConversationData)
  useLifoCacheTimeout()
  useAuthCheck()
  useChordTimeoutSync()
}
