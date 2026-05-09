/**
 * Gateway adapter handlers.
 *
 * Gateway adapters (e.g., the Hermes plugin) connect via a single WebSocket
 * and serve multiple conversations. They register with `gateway_register`
 * and receive `input` messages for any conversation of their type.
 */

import { AGENT_HOST_PROTOCOL_VERSION } from '../../shared/protocol'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const gatewayRegister: MessageHandler = (ctx, data) => {
  const protocolVersion = data.protocolVersion as number | undefined
  if (!protocolVersion || protocolVersion < AGENT_HOST_PROTOCOL_VERSION) {
    ctx.reply({
      type: 'protocol_upgrade_required',
      requiredVersion: AGENT_HOST_PROTOCOL_VERSION,
      message: `Gateway protocol version ${protocolVersion} is outdated. Required: ${AGENT_HOST_PROTOCOL_VERSION}`,
    })
    ctx.ws.close(4001, 'protocol_upgrade_required')
    return
  }

  const agentHostType = data.agentHostType as string
  if (!agentHostType) {
    ctx.reply({ type: 'gateway_register_result', ok: false, error: 'Missing agentHostType' })
    return
  }

  ctx.ws.data.isGateway = true
  ctx.ws.data.gatewayType = agentHostType
  ctx.conversations.setGatewaySocket(agentHostType, ctx.ws)

  const version = (data.version as string) || 'unknown'
  ctx.log.info(`[gateway] ${agentHostType} adapter connected (v${version})`)

  ctx.reply({
    type: 'gateway_register_result',
    ok: true,
    agentHostType,
  })
}

const gatewayHeartbeat: MessageHandler = (ctx, data) => {
  const agentHostType = ctx.ws.data.gatewayType
  if (!agentHostType) return
  ctx.conversations.setGatewaySocket(agentHostType, ctx.ws)
}

export function registerGatewayHandlers(): void {
  registerHandlers({
    gateway_register: gatewayRegister,
    gateway_heartbeat: gatewayHeartbeat,
  })
}
