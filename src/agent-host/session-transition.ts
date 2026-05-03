/**
 * Session Transition
 *
 * Single source of truth for "Claude Code just reported a session id".
 *
 * Two observers see session ids in the wrapper:
 *   1. SessionStart hook    -> hook-processor.ts
 *   2. stream-json init     -> headless-lifecycle.ts onInit
 *
 * In headless mode with hooks enabled both fire, in non-deterministic order.
 * Historically each tried to emit the right `session_promote` / `session_clear`
 * message on its own, with state (ctx.claudeSessionId, wsClient.ccSessionId,
 * ctx.pendingClearFromId) spread across three places. That produced a race
 * where the first observer promoted a post-/clear respawn as a boot, silently
 * advancing wsClient.ccSessionId, and the second observer's rekey was then
 * eaten by the "same-ID" guard in sendConversationRekey -- leaving the
 * broker pinned to the old session id. See diag log 2026-04-17
 * for the incident.
 *
 * The rule now: both observers delegate to `observeClaudeSessionId`, which
 * classifies the transition (boot / rekey / confirm) and performs the right
 * action exactly once. Idempotent on session id -- whichever observer fires
 * first does the work; subsequent calls with the same id return `confirm`
 * and no-op. One diag line per transition for easy debugging.
 */

import { cwdToProjectUri } from '../shared/project-uri'
import type { AgentHostContext } from './agent-host-context'
import { emitLaunchEvent } from './launch-events'
import { flushPendingTranscriptEntries } from './transcript-manager'

export type SessionTransitionKind = 'boot' | 'rekey' | 'confirm'
export type SessionTransitionSource = 'hook' | 'stream_json'
export type SessionTransitionReason =
  | 'first-init' // boot: never seen a session id before
  | 'post-clear' // rekey: respawn after /clear
  | 'unexpected' // rekey: session id changed without a known trigger (e.g. resume, compaction)
  | 'duplicate' // confirm: same id observed again (the other observer beat us)

export interface SessionTransition {
  kind: SessionTransitionKind
  source: SessionTransitionSource
  reason: SessionTransitionReason
  from: string | null
  to: string
  model?: string
}

/**
 * Observe that Claude Code has reported a session id. Classify the transition
 * (boot/rekey/confirm) and perform the right broker-facing action.
 *
 * MUST be called by both SessionStart hook handler and stream-json onInit.
 * Safe to call redundantly: subsequent calls with the same id no-op.
 *
 * Side effects on `ctx`:
 *   - Sets `claudeSessionId` to `newSessionId`
 *   - Clears `pendingClearFromId` if consumed (rekey/post-clear branch)
 *   - On rekey: stops all subagent watchers + restarts task/project watchers
 *   - On boot: may create wsClient (if none yet) or promote existing booting ws
 *
 * Broker messages sent:
 *   - boot + no wsClient     -> connectToBroker opens a fresh socket
 *   - boot + booting wsClient -> session_promote + meta (via setSessionId)
 *                                + session_ready boot_event
 *   - rekey                  -> session_clear (oldId, newId) on same socket
 *   - confirm                -> nothing
 */
export function observeClaudeSessionId(
  ctx: AgentHostContext,
  newSessionId: string,
  source: SessionTransitionSource,
  model?: string,
): SessionTransition {
  const prevSessionId = ctx.claudeSessionId
  const pendingClearFromId = ctx.pendingClearFromId

  // Confirm: same id observed again -- the other observer already handled it.
  if (prevSessionId === newSessionId) {
    return emitTransition(ctx, {
      kind: 'confirm',
      source,
      reason: 'duplicate',
      from: prevSessionId,
      to: newSessionId,
      model,
    })
  }

  // Classify: post-clear rekey > unexpected rekey > first-init boot.
  // pendingClearFromId is set by onExit when /clear respawns CC.
  const kind: SessionTransitionKind = prevSessionId || pendingClearFromId ? 'rekey' : 'boot'
  const reason: SessionTransitionReason = pendingClearFromId
    ? 'post-clear'
    : prevSessionId
      ? 'unexpected'
      : 'first-init'

  // Update ctx state BEFORE side effects so any reentrant code sees the new id.
  ctx.claudeSessionId = newSessionId
  ctx.pendingClearFromId = null

  if (kind === 'boot') {
    handleBoot(ctx, newSessionId, source, model)
  } else {
    // Effective "from" is pendingClearFromId for post-clear (onExit cleared
    // claudeSessionId in earlier code paths; we no longer do, but keep the
    // fallback so a missed update still produces a valid rekey message).
    const fromId = pendingClearFromId || prevSessionId || newSessionId
    handleRekey(ctx, fromId, newSessionId, model)
    emitLaunchEvent(ctx, 'rekeyed', {
      detail: `${fromId.slice(0, 8)} -> ${newSessionId.slice(0, 8)}`,
      raw: { from: fromId, to: newSessionId, reason },
    })
  }

  // Launch is now fully settled on this session id.
  emitLaunchEvent(ctx, 'ready', {
    detail: `session=${newSessionId.slice(0, 8)} kind=${kind}`,
  })

  // Flush any transcript entries that arrived before claudeSessionId was set
  // (e.g. the initial ad-hoc prompt in headless mode).
  flushPendingTranscriptEntries(ctx)

  return emitTransition(ctx, {
    kind,
    source,
    reason,
    from: pendingClearFromId || prevSessionId,
    to: newSessionId,
    model,
  })
}

function handleBoot(ctx: AgentHostContext, newId: string, source: SessionTransitionSource, model?: string): void {
  // If we never connected (broker unreachable at startup), connect now.
  if (!ctx.wsClient) {
    ctx.connectToBroker(newId)
    return
  }

  // wsClient exists -- promote the booting session (no-op if already promoted).
  ctx.wsClient.setSessionId(newId, source)
  ctx.wsClient.sendBootEvent('init_received', `session=${newId.slice(0, 8)} (${source})`, model ? { model } : undefined)
  ctx.wsClient.sendBootEvent('session_ready')
}

function handleRekey(ctx: AgentHostContext, fromId: string, newId: string, model?: string): void {
  // Tell broker to migrate session from old id to new id.
  // If wsClient is disconnected, the message drops on the floor -- acceptable
  // since a reconnect will send fresh meta with the new id anyway.
  if (ctx.wsClient?.isConnected()) {
    ctx.wsClient.sendConversationRekey(newId, cwdToProjectUri(ctx.cwd), model)
  }

  // Stop all subagent watchers -- they reference the old session's transcript dir.
  for (const [agentId, watcher] of ctx.subagentWatchers) {
    ctx.debug(`[rekey] Stopping subagent watcher: ${agentId.slice(0, 7)}`)
    watcher.stop()
  }
  ctx.subagentWatchers.clear()

  // Task watcher is keyed by session id (~/.claude/tasks/<session_id>/).
  // Tear down + restart so it picks up the new session's dir.
  ctx.lastTasksJson = ''
  if (ctx.taskWatcher) {
    ctx.taskWatcher.close()
    ctx.taskWatcher = null
  }
  ctx.startTaskWatching()
  ctx.startProjectWatching()

  // Caller is responsible for source-specific work (e.g. restarting the
  // transcript watcher from SessionStart's data.transcript_path).
  void fromId // retained in transition diag for debugging
}

function emitTransition(ctx: AgentHostContext, t: SessionTransition): SessionTransition {
  ctx.diag('session', `transition: ${t.kind} (${t.reason})`, {
    source: t.source,
    from: t.from?.slice(0, 8) ?? null,
    to: t.to.slice(0, 8),
    model: t.model,
  })
  return t
}
