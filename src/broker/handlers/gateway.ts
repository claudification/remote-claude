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

  // Reject if the WS wasn't authenticated as a gateway at upgrade. The
  // gatewayType is set from the gateway-registry record at auth time;
  // the handler used to self-elevate (Audit M3), letting any authenticated
  // WS connection register itself as a gateway adapter.
  if (!ctx.ws.data.isGateway || !ctx.ws.data.gatewayType) {
    ctx.reply({
      type: 'gateway_register_result',
      ok: false,
      error: 'Connection not authenticated as gateway',
    })
    ctx.ws.close(4003, 'forbidden')
    return
  }

  const claimedType = data.agentHostType as string
  if (!claimedType) {
    ctx.reply({ type: 'gateway_register_result', ok: false, error: 'Missing agentHostType' })
    return
  }
  // The gateway type is fixed at registry creation -- reject mismatches rather
  // than letting the message body override the trusted auth-time value.
  if (claimedType !== ctx.ws.data.gatewayType) {
    ctx.reply({
      type: 'gateway_register_result',
      ok: false,
      error: `agentHostType mismatch: registered as "${ctx.ws.data.gatewayType}", got "${claimedType}"`,
    })
    return
  }

  const agentHostType = ctx.ws.data.gatewayType
  ctx.conversations.setGatewaySocket(agentHostType, ctx.ws)

  const version = (data.version as string) || 'unknown'
  ctx.log.info(`[gateway] ${agentHostType} adapter connected (v${version})`)

  ctx.reply({
    type: 'gateway_register_result',
    ok: true,
    agentHostType,
  })
}

const gatewayHeartbeat: MessageHandler = ctx => {
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
