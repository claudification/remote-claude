/**
 * Handlers for .rclaude/rclaude.json config read/write via the host agent.
 *
 * Dashboard -> concentrator -> agent -> filesystem.
 * After a successful save, broadcasts notify_config_updated to all
 * wrappers at the target CWD so they hot-reload permission rules.
 */

import { randomUUID } from 'node:crypto'
import type { RclaudeConfigData, RclaudeConfigOk } from '../../shared/protocol'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const CONFIG_TIMEOUT_MS = 5000

const rclaudeConfigGet: MessageHandler = async (ctx, data) => {
  ctx.requirePermission('settings', data.cwd as string)
  const agent = ctx.requireAgent()
  const cwd = data.cwd as string
  const requestId = randomUUID()

  const result = await new Promise<RclaudeConfigData>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ctx.sessions.removeConfigListener(requestId)
      reject(new Error('Config read timed out'))
    }, CONFIG_TIMEOUT_MS)

    ctx.sessions.addConfigListener(requestId, msg => {
      clearTimeout(timeout)
      resolve(msg as RclaudeConfigData)
    })

    agent.send(JSON.stringify({ type: 'rclaude_config_get', requestId, cwd }))
  })

  ctx.reply(result as unknown as Record<string, unknown>)
}

const rclaudeConfigSet: MessageHandler = async (ctx, data) => {
  ctx.requirePermission('settings', data.cwd as string)
  const agent = ctx.requireAgent()
  const cwd = data.cwd as string
  const config = data.config
  const requestId = randomUUID()

  const result = await new Promise<RclaudeConfigOk>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ctx.sessions.removeConfigListener(requestId)
      reject(new Error('Config save timed out'))
    }, CONFIG_TIMEOUT_MS)

    ctx.sessions.addConfigListener(requestId, msg => {
      clearTimeout(timeout)
      resolve(msg as RclaudeConfigOk)
    })

    agent.send(JSON.stringify({ type: 'rclaude_config_set', requestId, cwd, config }))
  })

  if (result.ok) {
    const notified = ctx.sessions.broadcastToWrappersAtCwd(cwd, { type: 'notify_config_updated' })
    ctx.log.info(`Config saved for ${cwd} -- notified ${notified} wrapper(s)`)
  }

  ctx.reply(result as unknown as Record<string, unknown>)
}

const rclaudeConfigData: MessageHandler = (ctx, data) => {
  ctx.sessions.resolveConfig(data.requestId as string, data)
}

const rclaudeConfigOk: MessageHandler = (ctx, data) => {
  ctx.sessions.resolveConfig(data.requestId as string, data)
}

export function registerRclaudeConfigHandlers(): void {
  registerHandlers({
    rclaude_config_get: rclaudeConfigGet,
    rclaude_config_set: rclaudeConfigSet,
    rclaude_config_data: rclaudeConfigData,
    rclaude_config_ok: rclaudeConfigOk,
  })
}
