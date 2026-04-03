/**
 * Terminal relay handlers: dashboard <-> rclaude PTY forwarding.
 * All terminal messages are routed by wrapperId (physical PTY identity).
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const terminalAttach: MessageHandler = (ctx, data) => {
  const wid = data.wrapperId as string
  const sess = ctx.sessions.getSessionByWrapper(wid)
  if (sess) ctx.requirePermission('terminal:read', sess.cwd)
  const targetSocket = ctx.sessions.getSessionSocketByWrapper(wid)
  if (targetSocket) {
    const isFirstViewer = !ctx.sessions.hasTerminalViewers(wid)
    ctx.sessions.addTerminalViewer(wid, ctx.ws)
    if (isFirstViewer) {
      targetSocket.send(JSON.stringify(data))
    }
    ctx.log.debug(
      `[terminal] Attached to wrapper=${wid.slice(0, 8)} (${data.cols}x${data.rows}) [${ctx.sessions.getTerminalViewers(wid).size} viewer(s)]`,
    )
  } else {
    ctx.reply({ type: 'terminal_error', wrapperId: wid, error: 'Wrapper not connected' })
  }
}

const terminalDetach: MessageHandler = (ctx, data) => {
  const wid = data.wrapperId as string
  ctx.sessions.removeTerminalViewer(wid, ctx.ws)
  if (!ctx.sessions.hasTerminalViewers(wid)) {
    const detachSocket = ctx.sessions.getSessionSocketByWrapper(wid)
    if (detachSocket) {
      detachSocket.send(JSON.stringify(data))
    }
  }
  ctx.log.debug(
    `[terminal] Detached from wrapper=${wid.slice(0, 8)} [${ctx.sessions.getTerminalViewers(wid).size} viewer(s) remaining]`,
  )
}

const terminalData: MessageHandler = (ctx, data) => {
  const wid = data.wrapperId as string
  if (ctx.ws.data.isDashboard) {
    // Dashboard -> rclaude (user keystrokes) - requires terminal write
    const sess = ctx.sessions.getSessionByWrapper(wid)
    if (sess) ctx.requirePermission('terminal', sess.cwd)
    const targetSocket = ctx.sessions.getSessionSocketByWrapper(wid)
    if (targetSocket) {
      targetSocket.send(JSON.stringify(data))
    }
  } else if (ctx.ws.data.wrapperId) {
    // rclaude -> dashboard (PTY output) - broadcast to all viewers of this wrapper
    const viewers = ctx.sessions.getTerminalViewers(wid || ctx.ws.data.wrapperId)
    const msg = JSON.stringify(data)
    for (const viewer of viewers) {
      try {
        viewer.send(msg)
      } catch {}
    }
  }
}

const terminalResize: MessageHandler = (ctx, data) => {
  const sess = ctx.sessions.getSessionByWrapper(data.wrapperId as string)
  if (sess) ctx.requirePermission('terminal', sess.cwd)
  const targetSocket = ctx.sessions.getSessionSocketByWrapper(data.wrapperId as string)
  if (targetSocket) {
    targetSocket.send(JSON.stringify(data))
  }
}

const terminalError: MessageHandler = (ctx, data) => {
  // rclaude -> dashboard - broadcast to all viewers of this wrapper
  const viewers = ctx.sessions.getTerminalViewers((data.wrapperId as string) || ctx.ws.data.wrapperId || '')
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
