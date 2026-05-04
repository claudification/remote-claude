/**
 * Wire-message validation helpers.
 *
 * The broker's prime directive: NEVER accept bad data silently. Every input
 * field that the broker uses (slices, indexes, persists, broadcasts) MUST be
 * validated at the handler boundary. If validation fails, the broker rejects
 * the message loudly:
 *
 *   1. Logs a structured `[bad-data]` warning with sender info + field summary.
 *   2. Sends a typed `bad_message` reply back to the sender, naming the
 *      offending field(s) and reason.
 *   3. Returns null so the handler can early-return without mutating state.
 *
 * Use `requireString()` (or `requireOneOfStrings()` for unions) at the top of
 * any handler that reads required wire fields. Never use `as string` casts
 * for fields the handler relies on -- the cast lies; this function tells the
 * truth.
 */

import { AGENT_HOST_PROTOCOL_VERSION } from '../../shared/protocol'
import type { HandlerContext, MessageData } from '../handler-context'

/** Copy-pastable shell command we tell stale agent hosts to run. */
const UPGRADE_COMMAND = 'bun install -g @claudewerk/agent-host @claudewerk/sentinel'

interface BadDataReport {
  /** Wire message type (e.g. "meta") */
  type: string
  /** Field name that failed validation */
  field: string
  /** Human-readable reason */
  reason: string
  /** Actual value the sender provided (truncated for safety) */
  received: unknown
}

/**
 * Reject a wire message as malformed. Logs + replies to sender. Always
 * returns void so callers can `return rejectBadMessage(...)` to early-out.
 */
export function rejectBadMessage(ctx: HandlerContext, report: BadDataReport): void {
  const sender =
    ctx.ws.data.conversationId ||
    (ctx.ws.data.isSentinel ? `sentinel:${ctx.ws.data.sentinelAlias || ctx.ws.data.sentinelId || '?'}` : null) ||
    (ctx.ws.data.isControlPanel ? `dashboard:${ctx.ws.data.userName || '?'}` : null) ||
    'unknown'

  // Truncate received value so log entries stay sane and we never echo
  // multi-MB blobs back to the sender or into the broker log.
  let receivedForLog: string
  try {
    const s = typeof report.received === 'string' ? report.received : JSON.stringify(report.received)
    receivedForLog = s.length > 200 ? `${s.slice(0, 200)}...(truncated)` : s
  } catch {
    receivedForLog = `<${typeof report.received}>`
  }

  console.warn(
    `[bad-data] Rejected '${report.type}' from ${sender}: field='${report.field}' reason='${report.reason}' received=${receivedForLog}`,
  )

  ctx.reply({
    type: 'bad_message',
    originalType: report.type,
    field: report.field,
    reason: report.reason,
  })
}

/**
 * Validate that `data[field]` is a non-empty string. Returns the value on
 * success, or rejects + returns null on failure. Always early-return on null:
 *
 *   const sessionId = requireString(ctx, data, 'ccSessionId', 'meta')
 *   if (sessionId === null) return
 */
export function requireString(ctx: HandlerContext, data: MessageData, field: string, type: string): string | null {
  const value = data[field]
  if (typeof value !== 'string') {
    rejectBadMessage(ctx, {
      type,
      field,
      reason: `expected non-empty string, got ${value === undefined ? 'undefined' : typeof value}`,
      received: value,
    })
    return null
  }
  if (value.length === 0) {
    rejectBadMessage(ctx, {
      type,
      field,
      reason: 'expected non-empty string, got empty string',
      received: value,
    })
    return null
  }
  return value
}

/**
 * Validate multiple required string fields in one call. Returns an object
 * mapping field name -> validated value, or null if ANY field fails. On
 * failure the FIRST bad field is reported (subsequent ones are not reported
 * to keep the rejection signal-to-noise high).
 */
export function requireStrings<F extends string>(
  ctx: HandlerContext,
  data: MessageData,
  fields: readonly F[],
  type: string,
): Record<F, string> | null {
  const result = {} as Record<F, string>
  for (const field of fields) {
    const value = requireString(ctx, data, field, type)
    if (value === null) return null
    result[field] = value
  }
  return result
}

/**
 * Gate the connection on protocol version compatibility. Call FIRST in any
 * handler that creates or resumes a conversation (currently meta and
 * wrapper_boot). On mismatch: replies with `protocol_upgrade_required`,
 * broadcasts `agent_host_outdated` to dashboard subscribers, logs a
 * structured warn, and returns false so the handler can early-out without
 * touching state.
 *
 * The required version is hardcoded to AGENT_HOST_PROTOCOL_VERSION (the
 * latest the broker speaks). We do NOT support negotiating older versions
 * -- the wire shape changed in a way that can't be losslessly translated.
 */
export function requireProtocolVersion(ctx: HandlerContext, data: MessageData, type: string): boolean {
  const raw = data.protocolVersion
  const clientVersion: number | null = typeof raw === 'number' && Number.isFinite(raw) ? raw : null

  if (clientVersion !== null && clientVersion >= AGENT_HOST_PROTOCOL_VERSION) {
    return true
  }

  // Best-effort identity for the dashboard toast. The handler hasn't
  // populated ws.data yet (validation runs before any state is set), so
  // we read directly from the message.
  const conversationId = typeof data.conversationId === 'string' ? data.conversationId : null
  const project = typeof data.project === 'string' ? data.project : typeof data.cwd === 'string' ? data.cwd : null

  const reason =
    clientVersion === null
      ? `agent host did not send 'protocolVersion' field. Broker requires v${AGENT_HOST_PROTOCOL_VERSION} or newer.`
      : `agent host speaks protocol v${clientVersion}; broker requires v${AGENT_HOST_PROTOCOL_VERSION}.`

  console.warn(`[protocol] Rejected '${type}' from ${conversationId ?? 'unknown'}: ${reason} project=${project ?? '?'}`)

  ctx.reply({
    type: 'protocol_upgrade_required',
    serverProtocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    clientProtocolVersion: clientVersion,
    reason,
    upgradeCommand: UPGRADE_COMMAND,
    details:
      'The session->conversation rename (2026-05-04) renamed every wire field carrying a session id. ' +
      'Old field names like "sessionId" are no longer accepted. Upgrade to pick up the new protocol.',
  })

  // Broadcast to all dashboard subscribers so users see the issue even when
  // the agent host's terminal isn't visible (daemon, tmux, headless).
  ctx.broadcast({
    type: 'agent_host_outdated',
    conversationId,
    project,
    serverProtocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    clientProtocolVersion: clientVersion,
    upgradeCommand: UPGRADE_COMMAND,
    reason,
  })

  return false
}
