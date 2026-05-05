/**
 * Diagnostics Buffer
 * Batches structured diagnostic entries and flushes them to the broker.
 */

import type { AgentHostMessage } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { debug } from './debug'

const MAX_DIAG_BUFFER = 500

function flushDiag(ctx: AgentHostContext) {
  ctx.diagFlushTimer = null
  if (ctx.diagBuffer.length === 0) return
  if (!ctx.wsClient?.isConnected() || !ctx.claudeSessionId) return
  const entries = ctx.diagBuffer.splice(0)
  ctx.wsClient.send({ type: 'diag', conversationId: ctx.conversationId, entries } as unknown as AgentHostMessage)
}

function diag(ctx: AgentHostContext, type: string, msg: string, args?: unknown) {
  debug(`[diag] ${type}: ${msg}${args ? ` ${JSON.stringify(args)}` : ''}`)
  if (ctx.diagBuffer.length >= MAX_DIAG_BUFFER) {
    ctx.diagBuffer.splice(0, Math.floor(MAX_DIAG_BUFFER / 4))
    debug(`[diag] Buffer full, dropped ${Math.floor(MAX_DIAG_BUFFER / 4)} oldest entries`)
  }
  ctx.diagBuffer.push({ t: Date.now(), type, msg, args })
  if (!ctx.diagFlushTimer) {
    ctx.diagFlushTimer = setTimeout(() => flushDiag(ctx), 500)
  }
}

/**
 * Wire diag/flushDiag onto a context object. Call once after ctx is created.
 */
export function wireDiag(ctx: AgentHostContext) {
  ctx.diag = (type: string, msg: string, args?: unknown) => diag(ctx, type, msg, args)
  ctx.flushDiag = () => flushDiag(ctx)
}
