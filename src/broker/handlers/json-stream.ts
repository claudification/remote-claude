/**
 * Raw JSON stream handlers: dashboard tails raw CC NDJSON output from headless sessions.
 * Mirrors terminal_attach/detach pattern -- wrapper only relays when viewers are attached.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const jsonStreamAttach: MessageHandler = (ctx, data) => {
  const wid = data.conversationId as string
  const sess = ctx.conversations.findConversationByConversationId(wid)
  if (sess) ctx.requirePermission('chat:read', sess.project)
  const targetSocket = ctx.conversations.findSocketByConversationId(wid)
  if (targetSocket) {
    const isFirstViewer = !ctx.conversations.hasJsonStreamViewers(wid)
    ctx.conversations.addJsonStreamViewer(wid, ctx.ws)
    if (isFirstViewer) {
      targetSocket.send(JSON.stringify(data))
    }
    ctx.log.debug(
      `[json-stream] Attached to conv=${wid.slice(0, 8)} [${ctx.conversations.getJsonStreamViewers(wid).size} viewer(s)]`,
    )
  } else {
    ctx.reply({ type: 'json_stream_data', conversationId: wid, lines: [], isBackfill: false })
  }
}

const jsonStreamDetach: MessageHandler = (ctx, data) => {
  const wid = data.conversationId as string
  ctx.conversations.removeJsonStreamViewer(wid, ctx.ws)
  if (!ctx.conversations.hasJsonStreamViewers(wid)) {
    const targetSocket = ctx.conversations.findSocketByConversationId(wid)
    if (targetSocket) {
      targetSocket.send(JSON.stringify(data))
    }
  }
  ctx.log.debug(
    `[json-stream] Detached from conv=${wid.slice(0, 8)} [${ctx.conversations.getJsonStreamViewers(wid).size} viewer(s) remaining]`,
  )
}

const jsonStreamData: MessageHandler = (ctx, data) => {
  const wid = (data.conversationId as string) || ctx.ws.data.conversationId
  if (!wid) return
  const viewers = ctx.conversations.getJsonStreamViewers(wid)
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
