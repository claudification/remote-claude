/**
 * Host agent (sentinel) handlers: agent identification, spawn/revive results,
 * directory listing results, diagnostic entries.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const agentIdentify: MessageHandler = (ctx, data) => {
  const agentMeta = {
    machineId: typeof data.machineId === 'string' ? data.machineId : undefined,
    hostname: typeof data.hostname === 'string' ? data.hostname : undefined,
  }
  const accepted = ctx.sessions.setAgent(ctx.ws, agentMeta)
  if (accepted) {
    ctx.ws.data.isAgent = true
    ctx.reply({ type: 'ack', eventId: 'agent' })
    const label = agentMeta.hostname ? ` (${agentMeta.hostname} / ${agentMeta.machineId})` : ''
    ctx.log.info(`Host agent connected${label}`)
  } else {
    ctx.reply({ type: 'agent_reject', reason: 'Another agent is already connected' })
    ctx.ws.close(4409, 'Agent already connected')
  }
}

const reviveResult: MessageHandler = (ctx, data) => {
  const ok = data.success ? 'OK' : 'FAIL'
  ctx.log.debug(`Revive ${(data.sessionId as string)?.slice(0, 8)}... ${ok}${data.error ? ` (${data.error})` : ''}`)
}

const spawnResult: MessageHandler = (ctx, data) => {
  const ok = data.success ? 'OK' : 'FAIL'
  ctx.log.debug(`Spawn ${ok}${data.error ? ` (${data.error})` : ''}`)
  ctx.sessions.resolveSpawn(data.requestId as string, data)
}

const listDirsResult: MessageHandler = (ctx, data) => {
  ctx.sessions.resolveDir(data.requestId as string, data)
}

const agentDiag: MessageHandler = (ctx, data) => {
  if (Array.isArray(data.entries)) {
    for (const entry of data.entries) {
      ctx.sessions.pushAgentDiag(entry)
    }
  }
}

export function registerAgentHandlers(): void {
  registerHandlers({
    agent_identify: agentIdentify,
    revive_result: reviveResult,
    spawn_result: spawnResult,
    list_dirs_result: listDirsResult,
    agent_diag: agentDiag,
  })
}
