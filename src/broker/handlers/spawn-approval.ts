/**
 * Spawn approval handlers + sweep.
 *
 * When a non-benevolent caller invokes spawn, dispatchSpawn writes a
 * `pendingSpawnApproval` onto the caller conversation and returns
 * `pendingApproval`. The control panel renders the in-banner prompt; the human
 * clicks ALLOW or DENY which fires `spawn_approval_decision` over the WS.
 *
 * On ALLOW: re-dispatch the original SpawnRequest with `bypassApprovalGate`,
 * then append a TranscriptSpawnNotificationEntry (outcome=spawned|failed) to
 * the caller's transcript so the conversation that asked sees the receipt
 * inline.
 *
 * On DENY: append outcome=denied. No spawn dispatched.
 *
 * Also exports {@link expirePendingSpawnApprovals} -- called from broker
 * startup and a 1-hour interval. Auto-denies any pending approval older than
 * APPROVAL_TTL_MS with outcome=timed_out.
 */

import { randomUUID } from 'node:crypto'
import type { TranscriptSpawnNotificationEntry } from '../../shared/protocol'
import { mapProjectTrust, type SpawnCallerContext } from '../../shared/spawn-permissions'
import type { SpawnRequest } from '../../shared/spawn-schema'
import type { ConversationStore } from '../conversation-store'
import { getGlobalSettings } from '../global-settings'
import type { HandlerContext, MessageHandler } from '../handler-context'
import { DASHBOARD_ROLES, registerHandlers } from '../message-router'
import { getProjectSettings } from '../project-settings'
import { dispatchSpawn } from '../spawn-dispatch'

/** Auto-deny pending approvals older than 24h. */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
/** Sweep cadence -- a periodic timer reaps stale prompts. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

type BaseEntry = Omit<TranscriptSpawnNotificationEntry, 'outcome' | 'spawnedConversationId' | 'jobId' | 'error'>

/**
 * Append a TranscriptSpawnNotificationEntry to the caller's transcript and
 * broadcast it. Mirrors the cache + broadcast pattern used by chat-api / recap.
 */
function appendNotification(
  store: ConversationStore,
  conversationId: string,
  entry: TranscriptSpawnNotificationEntry,
): void {
  store.addTranscriptEntries(conversationId, [entry], false)
  store.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'transcript_entries',
    conversationId,
    entries: [entry],
    isInitial: false,
  })
}

function clearPending(store: ConversationStore, conversationId: string): void {
  const conv = store.getConversation(conversationId)
  if (!conv) return
  delete conv.pendingSpawnApproval
  if (conv.pendingAttention?.type === 'spawn_approval') {
    delete conv.pendingAttention
  }
  store.persistConversationById(conversationId)
  store.broadcastConversationUpdate(conversationId)
}

function buildBaseEntry(requestId: string, request: Record<string, unknown>, persist: boolean): BaseEntry {
  return {
    type: 'spawn_notification',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId,
    decidedAt: Date.now(),
    request,
    persistChosen: persist,
  }
}

function callerContextFor(callerProject: string | null): SpawnCallerContext {
  const callerTrust = callerProject ? mapProjectTrust(getProjectSettings(callerProject)?.trustLevel) : 'trusted'
  return { kind: 'mcp', hasSpawnPermission: true, trustLevel: callerTrust, callerProject }
}

/**
 * Re-dispatch an approved spawn with `bypassApprovalGate` and append the
 * spawned/failed notification to the caller's transcript.
 */
// fallow-ignore-next-line complexity
async function redispatchAndNotify(
  ctx: HandlerContext,
  conversationId: string,
  callerProject: string | null,
  baseEntry: BaseEntry,
  requestPayload: Record<string, unknown>,
): Promise<void> {
  const req = requestPayload as unknown as SpawnRequest
  try {
    const result = await dispatchSpawn(req, {
      conversationStore: ctx.conversations,
      getProjectSettings,
      getGlobalSettings,
      callerContext: callerContextFor(callerProject),
      rendezvousCallerConversationId: conversationId,
      bypassApprovalGate: true,
    })
    if (result.ok) {
      appendNotification(ctx.conversations, conversationId, {
        ...baseEntry,
        outcome: 'spawned',
        spawnedConversationId: result.conversationId,
        jobId: result.jobId,
      })
      return
    }
    // Should not happen with bypassApprovalGate -- log and treat as failed.
    const error = result.pendingApproval ? 'Approval bypass failed (unexpected pending response)' : result.error
    if (result.pendingApproval) {
      ctx.log.error(`[spawn-approval] unexpected pending after bypass: req=${baseEntry.requestId.slice(0, 8)}`)
    }
    appendNotification(ctx.conversations, conversationId, { ...baseEntry, outcome: 'failed', error })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.log.error(`[spawn-approval] re-dispatch threw: req=${baseEntry.requestId.slice(0, 8)}`, err)
    appendNotification(ctx.conversations, conversationId, { ...baseEntry, outcome: 'failed', error: msg })
  }
}

// fallow-ignore-next-line complexity
const handleSpawnApprovalDecision: MessageHandler = async (ctx, data) => {
  const conversationId = typeof data.conversationId === 'string' ? data.conversationId : undefined
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
  const decision = data.decision === 'allow' ? 'allow' : 'deny'
  const persist = data.persist === true

  if (!conversationId || !requestId) {
    ctx.log.error(`[spawn-approval] decision missing fields: ${JSON.stringify({ conversationId, requestId })}`)
    return
  }
  const caller = ctx.conversations.getConversation(conversationId)
  if (!caller) {
    ctx.log.error(`[spawn-approval] decision for unknown conversation: ${conversationId.slice(0, 8)}`)
    return
  }
  ctx.requirePermission('chat', caller.project)

  const pending = caller.pendingSpawnApproval
  if (!pending || pending.requestId !== requestId) {
    ctx.log.debug(
      `[spawn-approval] stale decision: req=${requestId.slice(0, 8)} pending=${pending?.requestId?.slice(0, 8) ?? 'none'}`,
    )
    return
  }

  const ageMs = Date.now() - pending.requestedAt
  const prevAuto = caller.spawnAutoApproved === true
  const nextAuto = decision === 'allow' && persist ? true : prevAuto
  // Apply the sticky bit BEFORE clearing so a follow-up race sees it.
  if (decision === 'allow' && persist) caller.spawnAutoApproved = true
  clearPending(ctx.conversations, conversationId)
  ctx.log.info(
    `[spawn-approval] decision caller=${conversationId.slice(0, 8)} req=${requestId.slice(0, 8)} decision=${decision} persist=${persist} ageMs=${ageMs} prevAuto=${prevAuto} nextAuto=${nextAuto} cwd=${pending.request.cwd ?? '?'} mode=${pending.request.permissionMode ?? 'default'}`,
  )

  const baseEntry = buildBaseEntry(requestId, pending.request, persist)
  if (decision === 'deny') {
    appendNotification(ctx.conversations, conversationId, { ...baseEntry, outcome: 'denied' })
    return
  }
  await redispatchAndNotify(ctx, conversationId, caller.project ?? null, baseEntry, pending.request)
}

/**
 * Sweep stale pending approvals. Auto-denies any prompt older than
 * APPROVAL_TTL_MS, appends a timed_out notification, and clears state.
 */
// fallow-ignore-next-line complexity
function expirePendingSpawnApprovals(store: ConversationStore): void {
  const cutoff = Date.now() - APPROVAL_TTL_MS
  let expired = 0
  for (const conv of store.getAllConversations()) {
    const pending = conv.pendingSpawnApproval
    if (!pending || pending.requestedAt > cutoff) continue
    const ageMs = Date.now() - pending.requestedAt
    console.log(
      `[spawn-approval] expiring caller=${conv.id.slice(0, 8)} req=${pending.requestId.slice(0, 8)} ageMs=${ageMs}`,
    )
    appendNotification(store, conv.id, {
      ...buildBaseEntry(pending.requestId, pending.request, false),
      outcome: 'timed_out',
    })
    clearPending(store, conv.id)
    expired += 1
  }
  if (expired > 0) console.log(`[spawn-approval] swept ${expired} stale prompt(s)`)
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic sweep. Idempotent -- second call replaces the timer. */
export function startSpawnApprovalSweep(store: ConversationStore): void {
  if (sweepTimer) clearInterval(sweepTimer)
  // Kick on startup so prompts left from the previous process are reaped, then
  // settle into the cadence.
  expirePendingSpawnApprovals(store)
  sweepTimer = setInterval(() => expirePendingSpawnApprovals(store), SWEEP_INTERVAL_MS)
}

export function registerSpawnApprovalHandlers(): void {
  registerHandlers({ spawn_approval_decision: handleSpawnApprovalDecision }, DASHBOARD_ROLES)
}
