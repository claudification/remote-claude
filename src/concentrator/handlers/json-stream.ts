/**
 * Raw JSON stream handlers: dashboard tails raw CC NDJSON output from headless sessions.
 * Mirrors terminal_attach/detach pattern -- wrapper only relays when viewers are attached.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const jsonStreamAttach: MessageHandler = (ctx, data) => {
  const wid = data.wrapperId as string
  const sess = ctx.sessions.getSessionByWrapper(wid)
  if (sess) ctx.requirePermission('chat:read', sess.cwd)
  const targetSocket = ctx.sessions.getSessionSocketByWrapper(wid)
  if (targetSocket) {
    const isFirstViewer = !ctx.sessions.hasJsonStreamViewers(wid)
    ctx.sessions.addJsonStreamViewer(wid, ctx.ws)
    if (isFirstViewer) {
      targetSocket.send(JSON.stringify(data))
    }
    ctx.log.debug(
      `[json-stream] Attached to wrapper=${wid.slice(0, 8)} [${ctx.sessions.getJsonStreamViewers(wid).size} viewer(s)]`,
    )
  } else {
    ctx.reply({ type: 'json_stream_data', wrapperId: wid, lines: [], isBackfill: false })
  }
}

const jsonStreamDetach: MessageHandler = (ctx, data) => {
  const wid = data.wrapperId as string
  ctx.sessions.removeJsonStreamViewer(wid, ctx.ws)
  if (!ctx.sessions.hasJsonStreamViewers(wid)) {
    const targetSocket = ctx.sessions.getSessionSocketByWrapper(wid)
    if (targetSocket) {
      targetSocket.send(JSON.stringify(data))
    }
  }
  ctx.log.debug(
    `[json-stream] Detached from wrapper=${wid.slice(0, 8)} [${ctx.sessions.getJsonStreamViewers(wid).size} viewer(s) remaining]`,
  )
}

const jsonStreamData: MessageHandler = (ctx, data) => {
  const wid = (data.wrapperId as string) || ctx.ws.data.wrapperId
  if (!wid) return
  const viewers = ctx.sessions.getJsonStreamViewers(wid)
  const msg = JSON.stringify(data)
  for (const viewer of viewers) {
    try {
      viewer.send(msg)
    } catch {}
  }
}

export function registerJsonStreamHandlers(): void {
  registerHandlers({
    json_stream_attach: jsonStreamAttach,
    json_stream_detach: jsonStreamDetach,
    json_stream_data: jsonStreamData,
  })
}
