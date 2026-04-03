/**
 * Channel handlers: inter-session messaging, session discovery, link management,
 * channel subscriptions, dashboard subscriptions, and session quit relay.
 */

import type { SubscriptionChannel } from '../../shared/protocol'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// ─── Dashboard subscription ────────────────────────────────────────

const subscribe: MessageHandler = (ctx, data) => {
  ctx.ws.data.isDashboard = true
  const pv = (data.protocolVersion as number) || 1
  ctx.sessions.addSubscriber(ctx.ws, pv)
  ctx.reply({ type: 'agent_status', connected: ctx.sessions.hasAgent() })
  ctx.log.debug(`Subscriber connected (v${pv}, total: ${ctx.sessions.getSubscriberCount()})`)
}

const refreshSessions: MessageHandler = ctx => {
  ctx.sessions.sendSessionsList(ctx.ws)
}

const syncCheck: MessageHandler = (ctx, data) => {
  ctx.sessions.handleSyncCheck(
    ctx.ws,
    (data.epoch as string) || '',
    (data.lastSeq as number) || 0,
    data.transcripts as Record<string, number> | undefined,
  )
  ctx.log.debug(
    `sync check: epoch=${((data.epoch as string) || '').slice(0, 8)} seq=${data.lastSeq || 0} transcripts=${data.transcripts ? Object.keys(data.transcripts as object).length : 0}`,
  )
}

// ─── Channel subscriptions (per-session event streams) ─────────────

const channelSubscribe: MessageHandler = (ctx, data) => {
  const channel = data.channel as SubscriptionChannel
  const sessionId = data.sessionId as string
  const agentId = data.agentId as string | undefined
  if (!channel || !sessionId) return
  ctx.sessions.subscribeChannel(ctx.ws, channel, sessionId, agentId)
  ctx.reply({ type: 'channel_ack', channel, sessionId, agentId, status: 'subscribed' })
  ctx.log.debug(`[channel] ${channel}:${sessionId.slice(0, 8)}${agentId ? `:${agentId.slice(0, 8)}` : ''} +sub`)
}

const channelUnsubscribe: MessageHandler = (ctx, data) => {
  const channel = data.channel as SubscriptionChannel
  const sessionId = data.sessionId as string
  const agentId = data.agentId as string | undefined
  if (!channel || !sessionId) return
  ctx.sessions.unsubscribeChannel(ctx.ws, channel, sessionId, agentId)
  ctx.reply({ type: 'channel_ack', channel, sessionId, agentId, status: 'unsubscribed' })
  ctx.log.debug(`[channel] ${channel}:${sessionId.slice(0, 8)}${agentId ? `:${agentId.slice(0, 8)}` : ''} -sub`)
}

const channelUnsubscribeAll: MessageHandler = ctx => {
  ctx.sessions.unsubscribeAllChannels(ctx.ws)
  ctx.log.debug('[channel] unsubscribed all')
}

// ─── Session discovery (list_sessions) ─────────────────────────────

const channelListSessions: MessageHandler = (ctx, data) => {
  const status = (data.status as string) || 'live'
  const showMetadata = !!data.show_metadata
  const callerSession = ctx.ws.data.sessionId
  const callerCwd = ctx.caller?.cwd
  const isBenevolent = ctx.callerSettings?.trustLevel === 'benevolent'
  const all = Array.from(ctx.sessions.getAllSessions())
  const result = all
    .filter(s => {
      if (status === 'all') return true
      const isLive = ctx.sessions.getActiveWrapperCount(s.id) > 0
      return status === 'live' ? isLive : !isLive
    })
    .filter(s => s.id !== callerSession)
    .map(s => {
      const linkStatus = callerSession ? ctx.sessions.checkSessionLink(callerSession, s.id) : 'unknown'
      const isLinked = linkStatus === 'linked'
      const showFull = isBenevolent || isLinked
      const shortCwd = s.cwd.split('/').slice(-2).join('/')
      const projSettings = ctx.getProjectSettings(s.cwd)
      const sessionName = s.title || projSettings?.label || s.cwd.split('/').pop() || s.cwd
      const isLive = ctx.sessions.getActiveWrapperCount(s.id) > 0
      const queueSize = ctx.messageQueue.getQueueSize(s.cwd)

      // Assign a stable local ID via the caller's address book
      const localId = callerCwd ? ctx.addressBook.getOrAssign(callerCwd, s.cwd, sessionName) : s.id

      return {
        id: localId, // stable local address (use for send_message, etc.)
        session_id: s.id,
        name: sessionName,
        cwd: showFull ? s.cwd : shortCwd,
        status: (isLive ? 'live' : 'inactive') as 'live' | 'inactive',
        ...(projSettings?.description ? { description: projSettings.description } : {}),
        link: isLinked ? 'connected' : linkStatus === 'blocked' ? 'blocked' : undefined,
        title: s.title,
        summary: s.summary,
        ...(queueSize > 0 ? { queued: queueSize } : {}),
        ...(showMetadata && isBenevolent && projSettings
          ? {
              metadata: {
                label: projSettings.label,
                icon: projSettings.icon,
                color: projSettings.color,
                keyterms: projSettings.keyterms,
              },
            }
          : {}),
      }
    })
  ctx.reply({ type: 'channel_sessions_list', sessions: result })
}

// ─── Inter-session messaging (channel_send) ────────────────────────

const channelSend: MessageHandler = (ctx, data) => {
  const fromSession = ctx.ws.data.sessionId || (data.fromSession as string)
  const toTarget = data.toSession as string
  if (!fromSession || !toTarget) return

  const fromSess = ctx.sessions.getSession(fromSession)
  const callerCwd = fromSess?.cwd

  // Resolve target: address book first, then wrapper ID, then session ID (backwards compat)
  const targetCwd = callerCwd ? ctx.addressBook.resolve(callerCwd, toTarget) : undefined
  const toSess = targetCwd
    ? Array.from(ctx.sessions.getAllSessions()).find(s => s.cwd === targetCwd)
    : ctx.sessions.getSessionByWrapper(toTarget) || ctx.sessions.getSession(toTarget)
  const toSession = toSess?.id

  // If we resolved a CWD but no active session, queue for offline delivery
  if (targetCwd && !toSess) {
    const fromProject =
      fromSess?.title ||
      ctx.getProjectSettings(callerCwd || '')?.label ||
      callerCwd?.split('/').pop() ||
      fromSession.slice(0, 8)
    // Resolve sender slug from receiver's address book (works even when target is offline)
    const fromSlug = callerCwd ? ctx.addressBook.getOrAssign(targetCwd, callerCwd, fromProject) : fromSession
    const conversationId = (data.conversationId as string) || `conv_${Date.now().toString(36)}`
    const delivery = {
      type: 'channel_deliver',
      fromSession: fromSlug,
      fromProject: fromSlug,
      intent: data.intent,
      message: data.message,
      context: data.context,
      conversationId,
    }
    ctx.messageQueue.enqueue(targetCwd, callerCwd || '', fromProject, delivery)
    ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'queued' })
    ctx.log.debug(`[inter-session] ${fromSession.slice(0, 8)} -> ${toTarget} (queued, target offline)`)
    return
  }

  if (!toSess || !toSession) {
    ctx.reply({
      type: 'channel_send_result',
      ok: false,
      error: 'Target not found. Use list_sessions to discover current sessions.',
    })
    return
  }

  const fromProject =
    fromSess?.title ||
    ctx.getProjectSettings(fromSess?.cwd || '')?.label ||
    fromSess?.cwd?.split('/').pop() ||
    fromSession.slice(0, 8)

  const linkStatus = ctx.sessions.checkSessionLink(fromSession, toSession)
  if (linkStatus === 'blocked') {
    ctx.reply({ type: 'channel_send_result', ok: false, error: 'Session has blocked your messages' })
    return
  }

  const conversationId = (data.conversationId as string) || `conv_${Date.now().toString(36)}`

  // Resolve sender identity from the RECEIVER's address book perspective
  const fromSlug =
    toSess.cwd && fromSess?.cwd ? ctx.addressBook.getOrAssign(toSess.cwd, fromSess.cwd, fromProject) : fromSession

  const delivery = {
    type: 'channel_deliver',
    fromSession: fromSlug,
    fromProject: fromSlug,
    intent: data.intent,
    message: data.message,
    context: data.context,
    conversationId,
  }

  const targetTrust = toSess.cwd ? ctx.getProjectSettings(toSess.cwd)?.trustLevel : undefined
  const fromTrust = fromSess?.cwd ? ctx.getProjectSettings(fromSess.cwd)?.trustLevel : undefined
  const isTrusted = targetTrust === 'open' || fromTrust === 'benevolent'

  const effectiveLinkStatus =
    linkStatus === 'unknown' && isTrusted
      ? 'trusted'
      : linkStatus === 'unknown' && fromSess?.cwd && toSess.cwd && ctx.links.find(fromSess.cwd, toSess.cwd)
        ? 'persisted'
        : linkStatus

  if (effectiveLinkStatus === 'linked' || effectiveLinkStatus === 'persisted' || effectiveLinkStatus === 'trusted') {
    if (effectiveLinkStatus !== 'linked') {
      ctx.sessions.linkSessions(fromSession, toSession)
      ctx.log.debug(
        `[links] Auto-linked (${effectiveLinkStatus}): ${fromSession.slice(0, 8)} <-> ${toSession.slice(0, 8)}`,
      )
    }

    const targetWs = ctx.sessions.getSessionSocket(toSession)
    if (targetWs) {
      targetWs.send(JSON.stringify(delivery))
      ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'delivered' })

      const toProject =
        toSess.title ||
        ctx.getProjectSettings(toSess.cwd)?.label ||
        toSess.cwd.split('/').pop() ||
        toSession.slice(0, 8)
      if (fromSess?.cwd && toSess.cwd) {
        ctx.links.touch(fromSess.cwd, toSess.cwd)
        ctx.logMessage({
          ts: Date.now(),
          from: { sessionId: fromSession, wrapperId: ctx.ws.data.wrapperId, cwd: fromSess.cwd, name: fromProject },
          to: { sessionId: toSession, cwd: toSess.cwd, name: toProject },
          intent: (data.intent as string) || 'notify',
          conversationId,
          preview: ((data.message as string) || '').slice(0, 200),
          fullLength: ((data.message as string) || '').length,
        })
      }
    } else {
      ctx.reply({
        type: 'channel_send_result',
        ok: false,
        error: 'Target session not connected. It may have restarted. Use list_sessions to resolve current IDs.',
      })
    }
  } else {
    ctx.sessions.queueInterSessionMessage(fromSession, toSession, delivery)
    const toProject =
      toSess.title || ctx.getProjectSettings(toSess.cwd)?.label || toSess.cwd.split('/').pop() || toSession.slice(0, 8)
    ctx.broadcast({
      type: 'channel_link_request',
      fromSession,
      fromProject,
      toSession,
      toProject,
    })
    ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'queued' })
  }
  ctx.log.debug(
    `[inter-session] ${fromSession.slice(0, 8)} -> ${toSession.slice(0, 8)}: ${data.intent} (${linkStatus})`,
  )
}

// ─── Quit session relay (dashboard -> wrapper) ─────────────────────

const quitSession: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const targetWs = sessionId ? ctx.sessions.getSessionSocket(sessionId) : null
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'quit_session', sessionId }))
    ctx.log.debug(`Session ${sessionId.slice(0, 8)} - SIGTERM sent to wrapper`)
  }
}

// ─── Session viewed (clear notification badge) ────────────────────

const sessionViewed: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) return
  const session = ctx.sessions.getSession(sessionId)
  if (session?.hasNotification) {
    session.hasNotification = false
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }
}

// ─── Link management (dashboard actions) ───────────────────────────

const channelLinkResponse: MessageHandler = (ctx, data) => {
  const fromSession = data.fromSession as string
  const toSession = data.toSession as string
  if (!fromSession || !toSession) return

  if (data.action === 'approve') {
    ctx.sessions.linkSessions(fromSession, toSession)
    const fromSess = ctx.sessions.getSession(fromSession)
    const toSess = ctx.sessions.getSession(toSession)
    if (fromSess?.cwd && toSess?.cwd) ctx.links.add(fromSess.cwd, toSess.cwd)
    const queued = ctx.sessions.drainQueuedMessages(fromSession, toSession)
    const targetWs = ctx.sessions.getSessionSocket(toSession)
    if (targetWs) {
      for (const msg of queued) targetWs.send(JSON.stringify(msg))
    }
    ctx.log.debug(`Link approved + persisted: ${fromSession.slice(0, 8)} <-> ${toSession.slice(0, 8)}`)
  } else {
    ctx.sessions.blockSession(fromSession, toSession)
    const fromSess = ctx.sessions.getSession(fromSession)
    const toSess = ctx.sessions.getSession(toSession)
    if (fromSess?.cwd && toSess?.cwd) ctx.links.remove(fromSess.cwd, toSess.cwd)
    ctx.sessions.drainQueuedMessages(fromSession, toSession) // discard
    ctx.log.debug(`Link blocked: ${fromSession.slice(0, 8)} X ${toSession.slice(0, 8)}`)
  }
}

const channelUnlink: MessageHandler = (ctx, data) => {
  const sessionA = data.sessionA as string
  const sessionB = data.sessionB as string
  if (!sessionA || !sessionB) return
  ctx.sessions.unlinkSessions(sessionA, sessionB)
  const sessA = ctx.sessions.getSession(sessionA)
  const sessB = ctx.sessions.getSession(sessionB)
  if (sessA?.cwd && sessB?.cwd) ctx.links.remove(sessA.cwd, sessB.cwd)
  ctx.sessions.broadcastSessionUpdate(sessionA)
  ctx.sessions.broadcastSessionUpdate(sessionB)
  ctx.log.debug(`Link severed: ${sessionA.slice(0, 8)} X ${sessionB.slice(0, 8)}`)
}

export function registerChannelHandlers(): void {
  registerHandlers({
    // Dashboard
    subscribe,
    refresh_sessions: refreshSessions,
    sync_check: syncCheck,
    // Channel subscriptions
    channel_subscribe: channelSubscribe,
    channel_unsubscribe: channelUnsubscribe,
    channel_unsubscribe_all: channelUnsubscribeAll,
    // Session discovery
    channel_list_sessions: channelListSessions,
    // Inter-session messaging
    channel_send: channelSend,
    // Session quit relay
    quit_session: quitSession,
    // Notification badge
    session_viewed: sessionViewed,
    // Link management
    channel_link_response: channelLinkResponse,
    channel_unlink: channelUnlink,
  })
}
