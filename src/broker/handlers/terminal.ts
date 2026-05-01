/**
 * Terminal relay handlers: dashboard <-> rclaude PTY forwarding.
 * All terminal messages are routed by conversationId (physical PTY identity).
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const terminalAttach: MessageHandler = (ctx, data) => {
  const wid = data.conversationId as string
  const sess = ctx.conversations.findConversationByConversationId(wid)
  if (sess) ctx.requirePermission('terminal:read', sess.project)
  const targetSocket = ctx.conversations.findSocketByConversationId(wid)
  if (targetSocket) {
    const isFirstViewer = !ctx.conversations.hasTerminalViewers(wid)
    ctx.conversations.addTerminalViewer(wid, ctx.ws)
    if (isFirstViewer) {
      targetSocket.send(JSON.stringify(data))
    }
    ctx.log.debug(
      `[terminal] Attached to conv=${wid.slice(0, 8)} (${data.cols}x${data.rows}) [${ctx.conversations.getTerminalViewers(wid).size} viewer(s)]`,
    )
  } else {
    ctx.reply({ type: 'terminal_error', conversationId: wid, error: 'Conversation not connected' })
  }
}

const terminalDetach: MessageHandler = (ctx, data) => {
  const wid = data.conversationId as string
  ctx.conversations.removeTerminalViewer(wid, ctx.ws)
  if (!ctx.conversations.hasTerminalViewers(wid)) {
    const detachSocket = ctx.conversations.findSocketByConversationId(wid)
    if (detachSocket) {
      detachSocket.send(JSON.stringify(data))
    }
  }
  ctx.log.debug(
    `[terminal] Detached from conv=${wid.slice(0, 8)} [${ctx.conversations.getTerminalViewers(wid).size} viewer(s) remaining]`,
  )
}

const terminalData: MessageHandler = (ctx, data) => {
  const wid = data.conversationId as string
  if (ctx.ws.data.isControlPanel) {
    // Dashboard -> rclaude (user keystrokes) - requires terminal write
    const sess = ctx.conversations.findConversationByConversationId(wid)
    if (sess) ctx.requirePermission('terminal', sess.project)
    const targetSocket = ctx.conversations.findSocketByConversationId(wid)
    if (targetSocket) {
      targetSocket.send(JSON.stringify(data))
    }
  } else if (ctx.ws.data.conversationId) {
    // rclaude -> dashboard (PTY output) - broadcast to all viewers of this wrapper
    const viewers = ctx.conversations.getTerminalViewers(wid || ctx.ws.data.conversationId)
    const msg = JSON.stringify(data)
    for (const viewer of viewers) {
      try {
        viewer.send(msg)
      } catch {}
    }
  }
}

const terminalResize: MessageHandler = (ctx, data) => {
  const sess = ctx.conversations.findConversationByConversationId(data.conversationId as string)
  if (sess) ctx.requirePermission('terminal', sess.project)
  const targetSocket = ctx.conversations.findSocketByConversationId(data.conversationId as string)
  if (targetSocket) {
    targetSocket.send(JSON.stringify(data))
  }
}

const terminalError: MessageHandler = (ctx, data) => {
  // rclaude -> dashboard - broadcast to all viewers of this wrapper
  const viewers = ctx.conversations.getTerminalViewers((data.conversationId as string) || ctx.ws.data.conversationId || '')
  const msg = JSON.stringify(data)
  for (const viewer of viewers) {
    try {
      viewer.send(msg)
    } catch {}
  }
}

export function registerTerminalHandlers(): void {
  registerHandlers({
    terminal_attach: terminalAttach,
    terminal_detach: terminalDetach,
    terminal_data: terminalData,
    terminal_resize: terminalResize,
    terminal_error: terminalError,
  })
}
