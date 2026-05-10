/**
 * Gateway adapter handlers.
 *
 * Gateway adapters (e.g., the Hermes plugin) connect via a single WebSocket
 * and serve multiple conversations. They register with `gateway_register`
 * and receive `input` messages for any conversation of their type.
 */

import { AGENT_HOST_PROTOCOL_VERSION } from '../../shared/protocol'
import type { MessageHandler } from '../handler-context'
import { GATEWAY_ONLY, registerHandlers } from '../message-router'

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

  // The gateway type is fixed at registry creation -- reject mismatches rather
  // than letting the message body override the trusted auth-time value.
  const claimedType = data.agentHostType as string
  if (!claimedType) {
    ctx.reply({ type: 'gateway_register_result', ok: false, error: 'Missing agentHostType' })
    return
  }
  if (claimedType !== ctx.ws.data.gatewayType) {
    ctx.reply({
      type: 'gateway_register_result',
      ok: false,
      error: `agentHostType mismatch: registered as "${ctx.ws.data.gatewayType}", got "${claimedType}"`,
    })
    return
  }
  const agentHostType = ctx.ws.data.gatewayType

  // gatewayId is set by auth-routes when the gateway secret is verified at WS upgrade.
  // Without it we cannot route per-gateway, so refuse the registration -- a gateway
  // connecting without an authenticated id is misconfigured.
  const gatewayId = ctx.ws.data.gatewayId
  if (!gatewayId) {
    ctx.reply({ type: 'gateway_register_result', ok: false, error: 'Gateway not authenticated' })
    ctx.ws.close(4002, 'gateway_unauthenticated')
    return
  }

  const alias = ctx.ws.data.gatewayAlias || gatewayId.slice(0, 8)
  ctx.conversations.setGatewaySocket(gatewayId, agentHostType, alias, ctx.ws)

  const version = (data.version as string) || 'unknown'
  ctx.log.info(`[gateway] ${agentHostType} adapter "${alias}" connected (v${version})`)

  ctx.reply({
    type: 'gateway_register_result',
    ok: true,
    agentHostType,
  })
}

const gatewayHeartbeat: MessageHandler = ctx => {
  const agentHostType = ctx.ws.data.gatewayType
  const gatewayId = ctx.ws.data.gatewayId
  if (!agentHostType || !gatewayId) return
  const alias = ctx.ws.data.gatewayAlias || gatewayId.slice(0, 8)
  ctx.conversations.setGatewaySocket(gatewayId, agentHostType, alias, ctx.ws)
}

export function registerGatewayHandlers(): void {
  // Gateway-only at the router level too (Audit M3). The handler still
  // double-checks ws.data.isGateway in case the role detection logic is
  // ever loosened.
  registerHandlers(
    {
      gateway_register: gatewayRegister,
      gateway_heartbeat: gatewayHeartbeat,
    },
    GATEWAY_ONLY,
  )
}
