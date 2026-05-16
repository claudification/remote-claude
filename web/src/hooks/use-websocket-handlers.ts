/**
 * WS message handlers for the dashboard.
 *
 * Each named function corresponds to one DashboardMessage `type`. Pulled out
 * of use-websocket.ts (was a 700-line switch in processMessage). The exported
 * `handlers` table is a Record<type, fn> consumed by the dispatcher.
 *
 * NOTE on Zustand stability: every state mutation here goes through
 * `useConversationsStore.setState` or `.getState()` -- never through a
 * subscribed selector -- so handler reorganization has no React #310 risk.
 */

import type { DialogLayout } from '@shared/dialog-schema'
import type { LaunchProfile } from '@shared/launch-profile'
import type {
  ConversationSummary,
  RecapCompleteMessage,
  RecapCreatedMessage,
  RecapErrorMessage,
  RecapPeriodLabel,
  RecapProgressMessage,
  RecapSummary,
} from '@shared/protocol'
import { handleLaunchProfilesUpdatedMessage } from '@/components/launch-profiles/use-launch-profiles'
import type {
  ClaudeEfficiencyUpdate,
  ClaudeHealthUpdate,
  Conversation,
  ProjectOrder,
  TaskInfo,
  TranscriptEntry,
} from '@/lib/types'
import { formatRateBucketName, haptic } from '@/lib/utils'
import {
  applyHashRoute,
  buildConversationsById,
  fetchTranscript,
  type ProjectSettingsMap,
  useConversationsStore,
} from './use-conversations'
import { useRecapJobsStore } from './use-recap-jobs'
import { handleSpawnRequestAck } from './use-spawn'

// Loose WS message type (mirror of use-websocket.ts -- intentionally duplicated
// to keep this module standalone; the canonical source lives in use-websocket.ts).
export interface DashboardMessage {
  type: string
  conversationId?: string
  previousConversationId?: string
  conversation?: ConversationSummary
  conversations?: ConversationSummary[]
  // biome-ignore lint/suspicious/noExplicitAny: pass-through for unknown server fields
  [key: string]: any
}

function toConversation(summary: ConversationSummary): Conversation {
  return {
    id: summary.id,
    project: summary.project,
    model: summary.model,
    capabilities: summary.capabilities,
    connectionIds: summary.connectionIds,
    startedAt: summary.startedAt,
    lastActivity: summary.lastActivity,
    status: summary.status,
    compacting: summary.compacting,
    compactedAt: summary.compactedAt,
    eventCount: summary.eventCount,
    activeSubagentCount: summary.activeSubagentCount ?? 0,
    totalSubagentCount: summary.totalSubagentCount ?? 0,
    subagents: summary.subagents ?? [],
    taskCount: summary.taskCount ?? 0,
    pendingTaskCount: summary.pendingTaskCount ?? 0,
    activeTasks: summary.activeTasks ?? [],
    pendingTasks: summary.pendingTasks ?? [],
    archivedTaskCount: summary.archivedTaskCount ?? 0,
    archivedTasks: summary.archivedTasks ?? [],
    runningBgTaskCount: summary.runningBgTaskCount ?? 0,
    bgTasks: summary.bgTasks ?? [],
    monitors: summary.monitors ?? [],
    runningMonitorCount: summary.runningMonitorCount ?? 0,
    teammates: summary.teammates ?? [],
    team: summary.team,
    effortLevel: summary.effortLevel,
    permissionMode: summary.permissionMode,
    lastError: summary.lastError,
    rateLimit: summary.rateLimit,
    planMode: summary.planMode,
    pendingAttention: summary.pendingAttention,
    pendingSpawnApproval: summary.pendingSpawnApproval,
    spawnAutoApproved: summary.spawnAutoApproved,
    hasNotification: summary.hasNotification,
    summary: summary.summary,
    title: summary.title,
    description: summary.description,
    agentName: summary.agentName,
    prLinks: summary.prLinks,
    linkedProjects: summary.linkedProjects,
    tokenUsage: summary.tokenUsage,
    contextWindow: summary.contextWindow,
    cacheTtl: summary.cacheTtl,
    lastTurnEndedAt: summary.lastTurnEndedAt,
    stats: summary.stats,
    costTimeline: summary.costTimeline,
    gitBranch: summary.gitBranch,
    adHocTaskId: summary.adHocTaskId,
    adHocWorktree: summary.adHocWorktree,
    resultText: summary.resultText,
    recap: summary.recap,
    recapFresh: summary.recapFresh,
    hostSentinelId: summary.hostSentinelId,
    hostSentinelAlias: summary.hostSentinelAlias,
    version: summary.version,
    buildTime: summary.buildTime,
    claudeVersion: summary.claudeVersion,
    claudeAuth: summary.claudeAuth,
    spinnerVerbs: summary.spinnerVerbs,
    autocompactPct: summary.autocompactPct,
    backend: summary.backend,
  }
}

// ─── sync protocol ─────────────────────────────────────────────────────────

function handleSyncOk(msg: DashboardMessage) {
  const ok = msg as DashboardMessage & { epoch?: string; seq?: number }
  const stale = (msg as DashboardMessage & { staleTranscripts?: Record<string, number> }).staleTranscripts
  const staleInfo = stale ? ` staleTranscripts=${Object.keys(stale).length}` : ''
  console.log(`[sync] <- sync_ok (epoch=${ok.epoch?.slice(0, 8)} seq=${ok.seq})${staleInfo}`)
}

function handleSyncCatchup(msg: DashboardMessage) {
  const cu = msg as DashboardMessage & { count?: number; epoch?: string; seq?: number }
  const stale = (msg as DashboardMessage & { staleTranscripts?: Record<string, number> }).staleTranscripts
  const staleInfo = stale ? ` staleTranscripts=${Object.keys(stale).length}` : ''
  console.log(`[sync] <- sync_catchup: ${cu.count} missed (epoch=${cu.epoch?.slice(0, 8)} seq=${cu.seq})${staleInfo}`)
}

function handleSyncStale(msg: DashboardMessage) {
  const stale = msg as DashboardMessage & { reason?: string; missed?: number; epoch?: string; seq?: number }
  const staleTranscripts = (msg as DashboardMessage & { staleTranscripts?: Record<string, number> }).staleTranscripts
  const staleInfo = staleTranscripts ? ` staleTranscripts=${Object.keys(staleTranscripts).length}` : ''
  console.log(`[sync] <- sync_stale: ${stale.reason || 'unknown'} missed=${stale.missed || '?'}${staleInfo}`)
  // Full resync needed - bump connectSeq (triggers LIFO eviction + re-fetch in onopen).
  // Clear lastAppliedTranscriptSeq: epoch changed means server's per-conversation
  // seq counters reset, so our stored seqs are from the previous generation
  // and would false-negative a future sync_check. The upcoming initial
  // transcript_entries broadcasts will reseed from fresh seqs.
  useConversationsStore.setState(s => ({
    connectSeq: s.connectSeq + 1,
    syncEpoch: stale.epoch || '',
    syncSeq: stale.seq || 0,
    lastAppliedTranscriptSeq: {},
  }))
}

// ─── conversation lifecycle ────────────────────────────────────────────────

function handleConversationsList(msg: DashboardMessage) {
  if (msg.conversations) {
    useConversationsStore.getState().setConversations(msg.conversations.map(toConversation))
    applyHashRoute()
  }
  // Version mismatch detection removed -- SW lifecycle handles update detection.
  // When sw.js changes, browser installs new SW and sends 'sw-updated' postMessage.
}

function handleConversationCreated(msg: DashboardMessage) {
  if (!msg.conversation) return
  const newConversation = toConversation(msg.conversation)
  useConversationsStore.setState(state => {
    let conversations: Conversation[]
    if (state.conversations.some(s => s.id === newConversation.id)) {
      conversations = state.conversations.map(s => (s.id === newConversation.id ? { ...s, ...newConversation } : s))
    } else {
      conversations = [...state.conversations, newConversation]
    }
    return { conversations, conversationsById: buildConversationsById(conversations) }
  })
}

function handleConversationUpdate(msg: DashboardMessage) {
  if (!(msg.conversation && msg.conversationId)) return
  const conversationId = msg.conversationId
  const conversation = msg.conversation
  const prevId = msg.previousConversationId
  const matchId = prevId || conversationId
  useConversationsStore.setState(state => {
    const updated = toConversation(conversation)
    // Rekey collision: if two booting placeholders (different conversationIds)
    // both get rekeyed to the same real conversation id, the map-replace leaves
    // two entries in the array with identical `updated.id`. Dedupe by id
    // (merge any duplicates into the first occurrence) so the sidebar
    // doesn't render ghost rows. Without dedupe, a double-spawn shows as
    // two identical conversation rows sharing a short-id.
    const replaced = state.conversations.map(s => (s.id === matchId ? { ...s, ...updated } : s))
    const seen = new Set<string>()
    const conversations: Conversation[] = []
    for (const s of replaced) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      conversations.push(s)
    }
    const newState: Partial<typeof state> = {
      conversations,
      conversationsById: buildConversationsById(conversations),
    }
    // Clear stale streaming text when conversation goes idle or ends
    if ((updated.status === 'idle' || updated.status === 'ended') && state.streamingText[conversationId]) {
      const { [conversationId]: _, ...rest } = state.streamingText
      newState.streamingText = rest
    }
    if (prevId && state.selectedConversationId === prevId) {
      console.log(
        `[nav] conversation rekey: ${prevId.slice(0, 8)} -> ${conversationId.slice(0, 8)} (selected conversation rekeyed)`,
      )
      newState.selectedConversationId = conversationId
      const oldEvents = state.events[prevId]
      const oldTranscripts = state.transcripts[prevId]
      if (oldEvents || oldTranscripts) {
        const events = { ...state.events }
        const transcripts = { ...state.transcripts }
        delete events[prevId]
        delete transcripts[prevId]
        // Preserve any data already received for the new conversation ID
        // (e.g. compacting marker broadcast during rekey)
        if (!events[conversationId]) events[conversationId] = []
        if (!transcripts[conversationId]) transcripts[conversationId] = []
        newState.events = events
        newState.transcripts = transcripts
      }
    }
    return newState
  })
  // Rekey: transcript moved from old-id to new-id locally, but we may have
  // missed channel entries under new-id while backgrounded. Re-fetch.
  if (prevId) {
    console.log(
      `[sync] session_update: REKEY ${prevId.slice(0, 8)} -> ${conversationId.slice(0, 8)} status=${conversation.status}`,
    )
    // Delay: broker processes rekey and re-receives transcript from rclaude.
    // 500ms gives the transcript watcher time to stream initial entries to the new ID.
    setTimeout(() => {
      fetchTranscript(conversationId).then(transcript => {
        console.log(
          `[sync] rekey refetch ${conversationId.slice(0, 8)}: ${transcript?.entries.length ?? 'null'} entries lastSeq=${transcript?.lastSeq ?? '-'}`,
        )
        if (transcript) useConversationsStore.getState().setTranscript(conversationId, transcript.entries)
      })
    }, 500)
  } else if (conversation.status === 'starting') {
    const state = useConversationsStore.getState()
    const cached = state.transcripts[conversationId]?.length ?? 0
    const isSelected = state.selectedConversationId === conversationId
    console.log(`[sync] session_update: RESUME ${conversationId.slice(0, 8)} selected=${isSelected} cached=${cached}`)
    if (isSelected) {
      // Always refetch on resume -- transcript may have been corrupted by a
      // same-ID rekey or the conversation may have new data from a restart.
      setTimeout(() => {
        fetchTranscript(conversationId).then(transcript => {
          console.log(
            `[sync] resume refetch ${conversationId.slice(0, 8)}: ${transcript?.entries.length ?? 'null'} entries lastSeq=${transcript?.lastSeq ?? '-'}`,
          )
          if (transcript) useConversationsStore.getState().setTranscript(conversationId, transcript.entries)
        })
      }, 1000)
    }
  }
}

function handleChannelAck(msg: DashboardMessage) {
  // Channel subscription acknowledgment - log for debugging
  const ack = msg as DashboardMessage & { channel?: string; previousConversationId?: string }
  if (ack.previousConversationId) {
    console.log(
      `[ws] Channel ${ack.channel} rolled over: ${ack.previousConversationId.slice(0, 8)} -> ${ack.conversationId?.slice(0, 8)}`,
    )
  }
}

function handleEvent(msg: DashboardMessage) {
  if (!(msg.event && msg.conversationId)) return
  const sid = msg.conversationId
  const evt = msg.event
  useConversationsStore.setState(state => {
    const currentEvents = state.events[sid] || []
    return {
      events: {
        ...state.events,
        [sid]: [...currentEvents, evt],
      },
    }
  })
}

// ─── transcripts + streaming ───────────────────────────────────────────────

function handleTranscriptEntries(msg: DashboardMessage) {
  if (!msg.conversationId || !msg.entries) return
  const sid = msg.conversationId
  const newEntries = msg.entries as TranscriptEntry[]
  const initial = msg.isInitial as boolean
  useConversationsStore.setState(state => {
    const existing = state.transcripts[sid] || []
    // isInitial=true REPLACES the cache. The agent host fires this on WS
    // reconnect (resendTranscriptFromFile in headless) and on PTY
    // truncation. If the snapshot is SMALLER than what we already have
    // AND the first entry matches, the snapshot was taken before CC
    // flushed the newest entries -- swallowing the replace would wipe
    // live entries the client already displayed. Skip in that case
    // (mirrors setTranscript's guard). When first entries differ
    // (e.g. /clear created a new conversation, or compaction rewrote
    // the prefix) the replace is legitimate -- proceed.
    let result: TranscriptEntry[]
    let skipped = false
    if (initial && existing.length > newEntries.length && existing.length > 0 && newEntries.length > 0) {
      const fp = (e: TranscriptEntry) => {
        const m = (e as { message?: { content?: unknown } }).message
        const c = m?.content
        return JSON.stringify(c ?? e.type)?.slice(0, 100)
      }
      if (fp(existing[0]) === fp(newEntries[0])) {
        result = existing
        skipped = true
      } else {
        result = newEntries
      }
    } else if (initial) {
      result = newEntries
    } else {
      // Incremental append -- dedup by seq against our last-applied.
      // Guards the race where a sync_check delta fetch raced with a live
      // WS broadcast and we applied the delta first. Without this guard,
      // the broadcast would re-append entries we already have.
      const localMax = state.lastAppliedTranscriptSeq[sid] ?? 0
      const fresh = newEntries.filter(e => e.seq === undefined || e.seq > localMax)
      if (fresh.length === 0) {
        return {}
      }
      result = [...existing, ...fresh]
    }
    if (initial || newEntries.length > 2) {
      console.log(
        `[ws] transcript ${sid.slice(0, 8)}: +${newEntries.length} ${initial ? (skipped ? 'INITIAL-SKIP' : 'INITIAL') : 'incremental'} (total=${result.length})`,
      )
    }
    // Clear streaming buffers when an assistant entry arrives (defensive
    // cleanup in case message_stop was lost or arrived after the transcript
    // entry).
    const hasAssistant = newEntries.some(e => e.type === 'assistant')
    const streamingText =
      hasAssistant && state.streamingText[sid]
        ? (() => {
            const { [sid]: _, ...rest } = state.streamingText
            return rest
          })()
        : state.streamingText
    const streamingThinking =
      hasAssistant && state.streamingThinking[sid]
        ? (() => {
            const { [sid]: _, ...rest } = state.streamingThinking
            return rest
          })()
        : state.streamingThinking
    // Update lastAppliedTranscriptSeq. For isInitial, ALWAYS take the snapshot's
    // max seq (even when skipped) so a broker restart that resets the counter
    // doesn't leave a stale high-water mark that filters all future entries.
    const maxSeqInResult = result.length > 0 ? (result[result.length - 1].seq ?? 0) : 0
    const prevSeq = state.lastAppliedTranscriptSeq[sid] ?? 0
    const newSeq = initial ? maxSeqInResult : Math.max(prevSeq, maxSeqInResult)
    return {
      transcripts: {
        ...state.transcripts,
        [sid]: result,
      },
      lastAppliedTranscriptSeq:
        newSeq !== prevSeq ? { ...state.lastAppliedTranscriptSeq, [sid]: newSeq } : state.lastAppliedTranscriptSeq,
      streamingText,
      streamingThinking,
      newDataSeq: state.newDataSeq + 1,
    }
  })
}

function handleConversationInfo(msg: DashboardMessage) {
  // Conversation metadata from headless init - store for autocomplete
  const sid = msg.conversationId as string
  if (!sid) return
  useConversationsStore.setState(state => ({
    conversationInfo: {
      ...state.conversationInfo,
      [sid]: {
        tools: (msg.tools as string[]) || [],
        slashCommands: (msg.slashCommands as string[]) || [],
        skills: (msg.skills as string[]) || [],
        agents: (msg.agents as string[]) || [],
        mcpServers: (msg.mcpServers as Array<{ name: string; status?: string }>) || [],
        model: (msg.model as string) || '',
        permissionMode: (msg.permissionMode as string) || '',
        claudeCodeVersion: (msg.claudeCodeVersion as string) || '',
      },
    },
  }))
  console.log(
    `[ws] conversation_info ${sid.slice(0, 8)}: ${(msg.tools as unknown[])?.length} tools, ${(msg.skills as unknown[])?.length} skills`,
  )
}

function handleStreamDelta(msg: DashboardMessage) {
  // Token streaming -- accumulate text + thinking deltas. Sources today:
  // headless CC `--include-partial-messages`, chat-api SSE, ACP agent host.
  const sid = msg.conversationId as string
  const event = msg.event as Record<string, unknown> | undefined
  if (!(sid && event)) return
  const eventType = event.type as string
  if (eventType === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      const text = delta.text as string
      useConversationsStore.setState(state => {
        const updated = (state.streamingText[sid] || '') + text
        // Bump newDataSeq every ~500 chars to trigger auto-scroll without thrashing
        const prevLen = (state.streamingText[sid] || '').length
        const bumpScroll = Math.floor(updated.length / 500) > Math.floor(prevLen / 500)
        return {
          streamingText: { ...state.streamingText, [sid]: updated },
          ...(bumpScroll ? { newDataSeq: state.newDataSeq + 1 } : {}),
        }
      })
    } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      const text = delta.thinking as string
      useConversationsStore.setState(state => {
        const updated = (state.streamingThinking[sid] || '') + text
        const prevLen = (state.streamingThinking[sid] || '').length
        const bumpScroll = Math.floor(updated.length / 500) > Math.floor(prevLen / 500)
        return {
          streamingThinking: { ...state.streamingThinking, [sid]: updated },
          ...(bumpScroll ? { newDataSeq: state.newDataSeq + 1 } : {}),
        }
      })
    }
  } else if (eventType === 'message_start') {
    // New text/thinking run -- reset streaming buffers. Do NOT reset on
    // content_block_start: a single assistant message can have multiple
    // blocks (interleaved with tool_use / thinking) and resetting on each
    // block wipes earlier deltas before message_stop flushes the final
    // assistant entry, making the first block look "missed" to the viewer.
    useConversationsStore.setState(state => {
      const hasText = !!state.streamingText[sid]
      const hasThinking = !!state.streamingThinking[sid]
      if (!hasText && !hasThinking) return state
      return {
        streamingText: hasText ? { ...state.streamingText, [sid]: '' } : state.streamingText,
        streamingThinking: hasThinking ? { ...state.streamingThinking, [sid]: '' } : state.streamingThinking,
      }
    })
  } else if (eventType === 'message_stop') {
    // Run / turn complete -- clear streaming buffers entirely
    useConversationsStore.setState(state => {
      const hasText = !!state.streamingText[sid]
      const hasThinking = !!state.streamingThinking[sid]
      if (!hasText && !hasThinking) return state
      const next: Partial<typeof state> = {}
      if (hasText) {
        const { [sid]: _, ...rest } = state.streamingText
        next.streamingText = rest
      }
      if (hasThinking) {
        const { [sid]: _, ...rest } = state.streamingThinking
        next.streamingThinking = rest
      }
      return next
    })
  }
}

function handleSubagentTranscript(msg: DashboardMessage) {
  if (!msg.conversationId || !msg.entries) return
  const subMsg = msg as DashboardMessage & { agentId?: string }
  const agentId = subMsg.agentId
  if (!agentId) return
  const sid = msg.conversationId
  const newEntries = msg.entries as TranscriptEntry[]
  const initial = msg.isInitial as boolean
  const key = `${sid}:${agentId}`
  useConversationsStore.setState(state => {
    const existing = state.subagentTranscripts[key] || []
    return {
      subagentTranscripts: {
        ...state.subagentTranscripts,
        [key]: initial ? newEntries : [...existing, ...newEntries],
      },
    }
  })
}

// ─── tasks / sentinel / settings ───────────────────────────────────────────

function handleTasksUpdate(msg: DashboardMessage) {
  if (!(msg.conversationId && msg.tasks)) return
  const sid = msg.conversationId
  const taskList = msg.tasks as TaskInfo[]
  useConversationsStore.setState(state => ({
    tasks: { ...state.tasks, [sid]: taskList },
  }))
}

function handleSentinelStatus(msg: DashboardMessage) {
  if (msg.connected !== undefined) {
    useConversationsStore.getState().setSentinelConnected(msg.connected, msg.sentinels)
  }
}

function handleUsageUpdate(msg: DashboardMessage) {
  if (msg.usage) {
    useConversationsStore.getState().setPlanUsage(msg.usage)
  }
}

function handleClaudeHealthUpdate(msg: DashboardMessage) {
  useConversationsStore.getState().setClaudeHealth(msg as unknown as ClaudeHealthUpdate)
}

function handleClaudeEfficiencyUpdate(msg: DashboardMessage) {
  useConversationsStore.getState().setClaudeEfficiency(msg as unknown as ClaudeEfficiencyUpdate)
}

function handleSettingsUpdated(msg: DashboardMessage) {
  if (msg.settings) {
    useConversationsStore.setState({ globalSettings: msg.settings as Record<string, unknown> })
  }
}

function handleLaunchProfilesUpdated(msg: DashboardMessage) {
  if (Array.isArray(msg.launchProfiles)) {
    handleLaunchProfilesUpdatedMessage(msg.launchProfiles as LaunchProfile[])
  }
}

function handleProjectSettingsUpdated(msg: DashboardMessage) {
  if (msg.settings) {
    useConversationsStore.getState().setProjectSettings(msg.settings as ProjectSettingsMap)
  }
}

function handleProjectOrderUpdated(msg: DashboardMessage) {
  if (msg.order) {
    useConversationsStore.getState().setProjectOrder(msg.order as ProjectOrder)
  }
}

function handleSharesUpdated(msg: DashboardMessage) {
  if (msg.shares) {
    useConversationsStore.getState().setShares(msg.shares)
  }
}

// ─── prompts / dialogs ─────────────────────────────────────────────────────

function handleChannelLinkRequest(msg: DashboardMessage) {
  const req = msg as DashboardMessage & {
    fromConversation?: string
    fromProject?: string
    toConversation?: string
    toProject?: string
  }
  const fromConversation = req.fromConversation
  const toConversation = req.toConversation
  if (!(fromConversation && toConversation)) return
  useConversationsStore.setState(state => {
    // Deduplicate
    if (
      state.pendingProjectLinks.some(
        r => r.fromConversation === fromConversation && r.toConversation === toConversation,
      )
    ) {
      return state
    }
    return {
      pendingProjectLinks: [
        ...state.pendingProjectLinks,
        {
          fromConversation,
          fromProject: req.fromProject || fromConversation.slice(0, 8),
          toConversation,
          toProject: req.toProject || toConversation.slice(0, 8),
        },
      ],
    }
  })
}

function handlePermissionRequest(msg: DashboardMessage) {
  const req = msg as DashboardMessage & {
    requestId?: string
    toolName?: string
    description?: string
    inputPreview?: string
  }
  const permSid = req.conversationId
  const permRid = req.requestId
  if (!(permSid && permRid)) return
  useConversationsStore.setState(state => {
    if (state.pendingPermissions.some(p => p.requestId === permRid)) return state
    return {
      pendingPermissions: [
        ...state.pendingPermissions,
        {
          conversationId: permSid,
          requestId: permRid,
          toolName: req.toolName || 'Unknown',
          description: req.description || '',
          inputPreview: req.inputPreview || '',
          timestamp: Date.now(),
        },
      ],
    }
  })
  // Haptic + visual alert for permission requests (haptic may be silent on iOS outside gestures)
  haptic('double')
}

function handlePermissionAutoApproved(msg: DashboardMessage) {
  const auto = msg as DashboardMessage & {
    requestId?: string
    toolName?: string
    description?: string
  }
  if (!(auto.conversationId && auto.toolName)) return
  // Emit a custom event that the conversation-detail can pick up for a brief toast
  window.dispatchEvent(
    new CustomEvent('permission-auto-approved', {
      detail: { conversationId: auto.conversationId, toolName: auto.toolName, description: auto.description },
    }),
  )
}

// Broker tells us a permission request was resolved (by this or another
// conversation). Drop it from the pending list so the prompt clears everywhere.
function handlePermissionDismiss(msg: DashboardMessage) {
  const permRid = msg.requestId as string | undefined
  if (!(msg.conversationId && permRid)) return
  useConversationsStore.setState(state => {
    if (!state.pendingPermissions.some(p => p.requestId === permRid)) return state
    return { pendingPermissions: state.pendingPermissions.filter(p => p.requestId !== permRid) }
  })
}

function handleAskQuestion(msg: DashboardMessage) {
  const askMsg = msg as DashboardMessage & {
    toolUseId?: string
    questions?: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string; preview?: string }>
      multiSelect?: boolean
    }>
  }
  const askSid = askMsg.conversationId
  const askTuid = askMsg.toolUseId
  if (!(askSid && askTuid && askMsg.questions)) return
  useConversationsStore.setState(state => {
    if (state.pendingAskQuestions.some(q => q.toolUseId === askTuid)) return state
    return {
      pendingAskQuestions: [
        ...state.pendingAskQuestions,
        {
          conversationId: askSid,
          toolUseId: askTuid,
          questions: askMsg.questions || [],
          timestamp: Date.now(),
        },
      ],
    }
  })
}

// Broker tells us an AskUserQuestion was resolved (by this or another conversation,
// or agent-host side). Drop it from the pending list so the card clears
// everywhere -- not just on the conversation that answered.
function handleAskDismiss(msg: DashboardMessage) {
  const askTuid = msg.toolUseId as string | undefined
  if (!(msg.conversationId && askTuid)) return
  useConversationsStore.setState(state => {
    if (!state.pendingAskQuestions.some(q => q.toolUseId === askTuid)) return state
    return { pendingAskQuestions: state.pendingAskQuestions.filter(q => q.toolUseId !== askTuid) }
  })
}

function handleDialogShow(msg: DashboardMessage) {
  const exSid = msg.conversationId as string
  const exId = msg.dialogId as string
  const exLayout = msg.layout as DialogLayout
  if (!(exSid && exId && exLayout)) return
  // Dedup: the agent host replays dialog_show on reconnect. If we already
  // have this exact dialog open, preserve any in-progress user input.
  const existing = useConversationsStore.getState().pendingDialogs[exSid]
  if (existing?.dialogId === exId) return
  useConversationsStore.setState(state => ({
    pendingDialogs: {
      ...state.pendingDialogs,
      [exSid]: { dialogId: exId, layout: exLayout, timestamp: Date.now() },
    },
  }))
}

function handleDialogDismiss(msg: DashboardMessage) {
  const exSid = msg.conversationId as string
  if (!exSid) return
  useConversationsStore.setState(state => {
    const updated = { ...state.pendingDialogs }
    delete updated[exSid]
    return { pendingDialogs: updated }
  })
}

function handlePlanApproval(msg: DashboardMessage) {
  const pa = msg as DashboardMessage & {
    requestId?: string
    toolUseId?: string
    plan?: string
    planFilePath?: string
    allowedPrompts?: string[]
  }
  const paSid = pa.conversationId
  if (!(paSid && pa.requestId && pa.plan)) return
  const dialogId = `plan_${pa.requestId}`
  // Dedup: agent host replays plan_approval on reconnect so the broker
  // can rebuild pending state. If we already have this exact dialog open,
  // don't overwrite -- would wipe any feedback the user has typed.
  const existing = useConversationsStore.getState().pendingDialogs[paSid]
  if (existing?.dialogId === dialogId && existing.source === 'plan_approval') return
  // Build a dialog layout from the plan content
  const layout: DialogLayout = {
    title: 'Plan Approval',
    timeout: 600,
    submitLabel: 'Approve',
    cancelLabel: 'Reject',
    body: [
      { type: 'Markdown', content: pa.plan },
      { type: 'Divider' },
      {
        type: 'TextInput',
        id: 'feedback',
        label: 'Feedback (optional)',
        placeholder: 'Changes or additional instructions...',
        multiline: true,
      },
    ],
  }
  useConversationsStore.setState(state => ({
    pendingDialogs: {
      ...state.pendingDialogs,
      [paSid]: {
        dialogId,
        layout,
        timestamp: Date.now(),
        source: 'plan_approval',
        meta: { requestId: pa.requestId, toolUseId: pa.toolUseId },
      },
    },
  }))
  haptic('double')
}

function handlePlanApprovalDismissed(msg: DashboardMessage) {
  const sid = msg.conversationId
  if (!sid) return
  useConversationsStore.setState(state => {
    const pending = state.pendingDialogs[sid]
    if (pending?.source === 'plan_approval') {
      const { [sid]: _, ...rest } = state.pendingDialogs
      return { pendingDialogs: rest }
    }
    return state
  })
}

function handleClipboardCapture(msg: DashboardMessage) {
  const clipMsg = msg as DashboardMessage & {
    contentType?: 'text' | 'image'
    text?: string
    base64?: string
    mimeType?: string
    timestamp?: number
  }
  if (!(clipMsg.conversationId && clipMsg.contentType)) return
  useConversationsStore.setState(state => {
    const capture = {
      id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      conversationId: clipMsg.conversationId || '',
      contentType: clipMsg.contentType || ('text' as const),
      text: clipMsg.text,
      base64: clipMsg.base64,
      mimeType: clipMsg.mimeType,
      timestamp: clipMsg.timestamp || Date.now(),
    }
    // Stack max 4, drop oldest
    const next = [capture, ...state.clipboardCaptures].slice(0, 4)
    return { clipboardCaptures: next }
  })
}

function handleConversationDismissed(msg: DashboardMessage) {
  if (!msg.conversationId) return
  useConversationsStore.setState(state => {
    const conversations = state.conversations.filter(s => s.id !== msg.conversationId)
    if (state.selectedConversationId === msg.conversationId) {
      console.log(`[nav] session_dismissed: clearing selection (WS dismissed ${msg.conversationId.slice(0, 8)})`)
    }
    return {
      conversations,
      conversationsById: buildConversationsById(conversations),
      selectedConversationId: state.selectedConversationId === msg.conversationId ? null : state.selectedConversationId,
    }
  })
}

// Server-pushed permissions (resolved from grants)
function handlePermissions(msg: DashboardMessage) {
  const update: Record<string, unknown> = {}
  if (msg.global) update.permissions = msg.global
  if (msg.conversations) {
    // Merge into existing conversationPermissions (incremental updates for new conversation)
    update.conversationPermissions = {
      ...useConversationsStore.getState().conversationPermissions,
      ...msg.conversations,
    }
  }
  if (Object.keys(update).length > 0) useConversationsStore.setState(update)
}

// ─── results + job events ──────────────────────────────────────────────────

const ACTION_TITLES: Record<string, string> = {
  send_input_result: 'Message not delivered',
  dismiss_conversation_result: 'Dismiss failed',
  dismiss_session_result: 'Dismiss failed',
  update_settings_result: 'Settings update failed',
  update_project_settings_result: 'Project settings update failed',
  delete_project_settings_result: 'Project settings delete failed',
  update_project_order_result: 'Reorder failed',
  revive_conversation_result: 'Revive failed',
  revive_session_result: 'Revive failed',
  rename_conversation_result: 'Rename failed',
  conversation_control_result: 'Control action failed',
  recap_request_result: 'Recap failed',
}

function handleActionResult(msg: DashboardMessage) {
  if (msg.ok === false) {
    const type = (msg.type as string) || 'action'
    const error = (msg.error as string) || 'unknown error'
    console.error(`[ws] ${type}: ${error}`)
    const title = ACTION_TITLES[type] ?? `Action failed: ${type}`
    window.dispatchEvent(
      new CustomEvent('rclaude-toast', {
        detail: { title, body: error, variant: 'warning' },
      }),
    )
  }
  window.dispatchEvent(new CustomEvent('revive-conversation-result', { detail: msg }))
}

function handleReviveResult(msg: DashboardMessage) {
  // Agent's revive result -- forwarded by broker for pipeline tracking
  window.dispatchEvent(new CustomEvent('revive-agent-result', { detail: msg }))
}

function handleLaunchJobEvent(msg: DashboardMessage) {
  window.dispatchEvent(new CustomEvent('launch-job-event', { detail: msg }))
}

// ─── recap job widget ──────────────────────────────────────────────────────

function handleRecapProgress(msg: DashboardMessage) {
  useRecapJobsStore.getState().applyProgress(msg as unknown as RecapProgressMessage)
}

function handleRecapComplete(msg: DashboardMessage) {
  useRecapJobsStore.getState().applyComplete(msg as unknown as RecapCompleteMessage)
}

function handleRecapCreated(msg: DashboardMessage) {
  useRecapJobsStore.getState().applyCreated(
    msg as unknown as RecapCreatedMessage & {
      projectUri?: string
      periodLabel?: RecapPeriodLabel
    },
  )
}

function handleRecapError(msg: DashboardMessage) {
  // The broker echoes recap_error with optional requestId; the dashboard's
  // create flow stamps a recapId on its outbound recap_create when it knows
  // it. For broker-side errors that don't carry a recapId we still surface
  // a toast so the user sees what failed.
  useRecapJobsStore.getState().applyError(msg as unknown as RecapErrorMessage)
  if (typeof msg.error === 'string') {
    window.dispatchEvent(
      new CustomEvent('rclaude-toast', {
        detail: { title: 'Recap error', body: msg.error, variant: 'warning' },
      }),
    )
  }
}

function handleRecapListResult(msg: DashboardMessage) {
  const recaps = msg.recaps as RecapSummary[] | undefined
  if (Array.isArray(recaps)) useRecapJobsStore.getState().syncFromList(recaps)
}

function handleSpawnRequestAckMsg(msg: DashboardMessage) {
  handleSpawnRequestAck(
    msg as unknown as {
      type: 'spawn_request_ack'
      ok: boolean
      jobId?: string
      conversationId?: string
      tmuxSession?: string
      error?: string
    },
  )
}

// ─── rate limit status ──────────────────────────────────────────────────────

function handleRateLimitStatus(msg: DashboardMessage) {
  const status = msg.status as string | undefined
  const rateLimitType = msg.rateLimitType as string | undefined
  const utilization = ((msg.raw as Record<string, unknown>)?.rate_limit_info as Record<string, unknown> | undefined)
    ?.utilization as number | undefined
  const conversationId = msg.conversationId as string | undefined

  if (status === 'allowed') return // No toast when cleared

  const isCritical = (utilization ?? 0) >= 0.75
  const dismissalKey = `rate-limit-dismissed:${conversationId}:${rateLimitType}`
  const dismissedAt = localStorage.getItem(dismissalKey)
  const now = Date.now()
  const oneHourAgo = now - 60 * 60 * 1000

  // Skip if dismissed within the last hour
  if (dismissedAt && parseInt(dismissedAt, 10) > oneHourAgo) {
    return
  }

  const limitLabel = formatRateBucketName(rateLimitType)
  const utilizationPct = utilization ? Math.round(utilization * 100) : '?'
  const toastId = `${conversationId}:${rateLimitType}`

  const retryText = msg.retryAfterMs ? ` Retry in ${Math.ceil(msg.retryAfterMs / 1000)}s.` : ''
  const originalDetail = {
    title: isCritical ? '🔔 Rate Limited' : 'Rate Limited',
    body: `${limitLabel} limit at ${utilizationPct}%.${retryText}`,
    variant: 'warning',
    persistent: isCritical, // Persist only if utilization >= 75%
    conversationId,
    toastId,
  }

  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail: originalDetail }))

  // Set up listener to mark dismissed when user closes the toast (if persistent)
  if (isCritical) {
    const handleDismiss = () => {
      localStorage.setItem(dismissalKey, now.toString())
      window.removeEventListener(`toast-dismissed:${toastId}`, handleDismiss)
    }
    window.addEventListener(`toast-dismissed:${toastId}`, handleDismiss)
  }
}

// ─── dispatch table ────────────────────────────────────────────────────────

export type MessageHandler = (msg: DashboardMessage) => void

export const handlers: Record<string, MessageHandler> = {
  // sync
  sync_ok: handleSyncOk,
  sync_catchup: handleSyncCatchup,
  sync_stale: handleSyncStale,
  // conversation lifecycle
  conversations_list: handleConversationsList,
  conversation_created: handleConversationCreated,
  conversation_ended: handleConversationUpdate,
  conversation_update: handleConversationUpdate,
  channel_ack: handleChannelAck,
  event: handleEvent,
  // transcripts + streaming
  transcript_entries: handleTranscriptEntries,
  conversation_info: handleConversationInfo,
  stream_delta: handleStreamDelta,
  subagent_transcript: handleSubagentTranscript,
  // tasks / sentinel / settings
  tasks_update: handleTasksUpdate,
  sentinel_status: handleSentinelStatus,
  usage_update: handleUsageUpdate,
  claude_health_update: handleClaudeHealthUpdate,
  claude_efficiency_update: handleClaudeEfficiencyUpdate,
  rate_limit_status: handleRateLimitStatus,
  settings_updated: handleSettingsUpdated,
  launch_profiles_updated: handleLaunchProfilesUpdated,
  project_settings_updated: handleProjectSettingsUpdated,
  project_order_updated: handleProjectOrderUpdated,
  shares_updated: handleSharesUpdated,
  // prompts + dialogs
  channel_link_request: handleChannelLinkRequest,
  permission_request: handlePermissionRequest,
  permission_dismiss: handlePermissionDismiss,
  permission_auto_approved: handlePermissionAutoApproved,
  ask_question: handleAskQuestion,
  ask_dismiss: handleAskDismiss,
  dialog_show: handleDialogShow,
  dialog_dismiss: handleDialogDismiss,
  plan_approval: handlePlanApproval,
  plan_approval_dismissed: handlePlanApprovalDismissed,
  clipboard_capture: handleClipboardCapture,
  conversation_dismissed: handleConversationDismissed,
  permissions: handlePermissions,
  // results + job events
  send_input_result: handleActionResult,
  dismiss_conversation_result: handleActionResult,
  dismiss_session_result: handleActionResult, // backward compat
  update_settings_result: handleActionResult,
  update_project_settings_result: handleActionResult,
  delete_project_settings_result: handleActionResult,
  update_project_order_result: handleActionResult,
  revive_conversation_result: handleActionResult,
  revive_session_result: handleActionResult, // backward compat
  recap_request_result: handleActionResult,
  revive_result: handleReviveResult,
  launch_log: handleLaunchJobEvent,
  launch_progress: handleLaunchJobEvent,
  job_complete: handleLaunchJobEvent,
  job_failed: handleLaunchJobEvent,
  spawn_request_ack: handleSpawnRequestAckMsg,
  // recap jobs widget
  recap_progress: handleRecapProgress,
  recap_complete: handleRecapComplete,
  recap_created: handleRecapCreated,
  recap_error: handleRecapError,
  recap_list_result: handleRecapListResult,
}
