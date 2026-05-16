import type { RecapAudience, RecapCreateMessage, RecapStatus } from '../../shared/protocol'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { DASHBOARD_ROLES, registerHandlers } from '../message-router'
import { getRecapOrchestrator } from '../recap-orchestrator'
import { requireStrings } from './validate'

function recapCreate(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['projectUri', 'timeZone'] as const, 'recap_create')
  if (!fields) return
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
  const echo = requestId ? { requestId } : {}
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) {
    ctx.reply({ type: 'recap_error', error: 'recap orchestrator not initialised', ...echo })
    return
  }
  const period = (data.period as RecapCreateMessage['period']) ?? null
  if (!period?.label) {
    ctx.reply({ type: 'recap_error', error: 'period.label is required', ...echo })
    return
  }
  if (fields.projectUri !== '*') ctx.requirePermission('chat:read', fields.projectUri)
  // audience: pass through whatever the caller set (the MCP tool defaults it
  // to 'agent'); undefined -> orchestrator defaults to 'human'.
  const audience: RecapAudience | undefined =
    data.audience === 'agent' || data.audience === 'human' ? data.audience : undefined
  // inform_on_complete: the target conversation is the CALLER's own
  // conversation, derived from the WS connection -- never passed by the agent.
  const informOnComplete = data.inform_on_complete === true
  const informConversationId = informOnComplete ? ctx.ws.data.conversationId : undefined
  if (informOnComplete && !informConversationId) {
    ctx.log.debug('[recap_create] inform_on_complete set but caller has no conversationId -- push skipped')
  }
  orchestrator
    .start({
      type: 'recap_create',
      projectUri: fields.projectUri,
      period,
      timeZone: fields.timeZone,
      signals: data.signals as RecapCreateMessage['signals'],
      force: Boolean(data.force),
      ...(audience ? { audience } : {}),
      ...(informConversationId ? { informConversationId } : {}),
    })
    .then(result => ctx.reply({ type: 'recap_created', recapId: result.recapId, cached: result.cached, ...echo }))
    .catch((err: unknown) => ctx.reply({ type: 'recap_error', error: describe(err), ...echo }))
}

function recapCancel(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['recapId'] as const, 'recap_cancel')
  if (!fields) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) return
  orchestrator.cancel(fields.recapId)
  ctx.reply({ type: 'recap_cancelled', recapId: fields.recapId })
}

function recapDismissFailed(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['recapId'] as const, 'recap_dismiss_failed')
  if (!fields) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) return
  orchestrator.dismiss(fields.recapId)
  ctx.reply({ type: 'recap_dismissed', recapId: fields.recapId })
}

function recapList(ctx: HandlerContext, data: MessageData): void {
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) {
    ctx.reply({ type: 'recap_list_result', recaps: [] })
    return
  }
  const rows = orchestrator.list({
    projectUri: typeof data.projectUri === 'string' ? data.projectUri : undefined,
    status: Array.isArray(data.status) ? (data.status as RecapStatus[]) : undefined,
    limit: typeof data.limit === 'number' ? data.limit : undefined,
  })
  ctx.reply({ type: 'recap_list_result', recaps: rows })
}

function recapGet(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['recapId'] as const, 'recap_get')
  if (!fields) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) {
    ctx.reply({ type: 'recap_error', error: 'recap orchestrator not initialised' })
    return
  }
  const result = orchestrator.get(fields.recapId, Boolean(data.includeLogs))
  if (!result) {
    ctx.reply({ type: 'recap_error', error: 'recap not found' })
    return
  }
  ctx.reply({ type: 'recap_get_result', recap: result.recap, ...(result.logs ? { logs: result.logs } : {}) })
}

function recapSearch(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['requestId', 'query'] as const, 'recap_search_request')
  if (!fields) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) {
    ctx.reply({
      type: 'recap_search_result',
      requestId: fields.requestId,
      ok: false,
      error: 'orchestrator not initialised',
    })
    return
  }
  const results = orchestrator.search(fields.query, {
    projectFilter: typeof data.projectFilter === 'string' ? data.projectFilter : undefined,
    limit: typeof data.limit === 'number' ? data.limit : undefined,
  })
  ctx.reply({ type: 'recap_search_result', requestId: fields.requestId, ok: true, results })
}

function recapMcpGet(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['requestId', 'recapId'] as const, 'recap_mcp_get_request')
  if (!fields) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) return
  const result = orchestrator.get(fields.recapId, false)
  if (!result) {
    ctx.reply({ type: 'recap_mcp_get_result', requestId: fields.requestId, ok: false, error: 'not found' })
    return
  }
  ctx.reply({ type: 'recap_mcp_get_result', requestId: fields.requestId, ok: true, recap: result.recap })
}

function recapMcpList(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['requestId'] as const, 'recap_mcp_list_request')
  if (!fields) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) return
  const recaps = orchestrator.list({
    projectUri: typeof data.projectFilter === 'string' ? data.projectFilter : undefined,
    limit: typeof data.limit === 'number' ? data.limit : undefined,
  })
  ctx.reply({ type: 'recap_mcp_list_result', requestId: fields.requestId, ok: true, recaps })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerRecapHandlers(): void {
  registerHandlers(
    {
      recap_create: recapCreate,
      recap_cancel: recapCancel,
      recap_dismiss_failed: recapDismissFailed,
      recap_list: recapList,
      recap_get: recapGet,
      recap_search_request: recapSearch,
      recap_mcp_get_request: recapMcpGet,
      recap_mcp_list_request: recapMcpList,
    } satisfies Record<string, MessageHandler>,
    DASHBOARD_ROLES,
  )
}
