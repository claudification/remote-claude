/**
 * Recap MCP tools.
 *
 * Four tools that expose the broker's period-recap feature to agents:
 *   - recap_search  -- FTS5 across recaps the agent's user can read
 *   - recap_get     -- Full recap markdown + metadata by id
 *   - recap_list    -- Recent recaps for a project (or all accessible projects)
 *   - recap_create  -- Kick off a new recap, returns the recap id
 *
 * All four are pass-throughs: the tool minted an MCP-side requestId via
 * brokerRpc and waits for the matching broker reply. Permission gating happens
 * server-side (the broker resolves the agent host's user + project scope).
 *
 * "@self" in projectUri/projectFilter is resolved to the agent host's
 * conversation project URI before the broker call.
 */

import { cwdToProjectUri } from '../../shared/project-uri'
import type { PeriodRecapDoc, RecapPeriodLabel, RecapSearchHit, RecapSignal, RecapSummary } from '../../shared/protocol'
import { brokerRpc, hasBrokerRpcSender } from './lib/broker-rpc'
import type { McpToolContext, ToolDef, ToolResult } from './types'

const PERIOD_LABELS: RecapPeriodLabel[] = [
  'today',
  'yesterday',
  'last_7',
  'last_30',
  'this_week',
  'this_month',
  'custom',
]

function notConnected(): ToolResult {
  return {
    content: [{ type: 'text', text: 'Error: broker connection not ready (no RPC sender)' }],
    isError: true,
  }
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function resolveProjectFilter(ctx: McpToolContext, raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed === '*') return '*'
  if (trimmed === '@self') {
    const identity = ctx.getIdentity()
    if (!identity) return undefined
    return cwdToProjectUri(identity.cwd)
  }
  return trimmed
}

function resolveTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof tz === 'string' && tz.length > 0) return tz
  } catch {
    /* fall through */
  }
  return 'UTC'
}

function formatSearchHit(hit: RecapSearchHit): string {
  const start = new Date(hit.periodStart).toISOString().slice(0, 10)
  const end = new Date(hit.periodEnd).toISOString().slice(0, 10)
  const snippet = hit.snippet.replace(/<\/?mark>/g, '*').trim()
  return `[${hit.id}]  ${hit.title}\n  ${hit.subtitle}\n  ${start} - ${end}  |  score ${hit.score.toFixed(2)}\n  ${snippet}`
}

// fallow-ignore-next-line complexity
function formatSummary(s: RecapSummary): string {
  const start = new Date(s.periodStart).toISOString().slice(0, 10)
  const end = new Date(s.periodEnd).toISOString().slice(0, 10)
  const cost = s.llmCostUsd > 0 ? ` $${s.llmCostUsd.toFixed(4)}` : ''
  const status = s.status === 'done' ? '' : ` [${s.status}]`
  return `[${s.id}]${status}  ${s.title || s.projectUri}\n  ${start} - ${end}  ${s.subtitle || ''}${cost}`
}

function recapSearchTool(ctx: McpToolContext): ToolDef {
  return {
    description:
      'Search prior period recaps via FTS5 across all recaps the caller can read. ' +
      'Use this when the user asks about past work, decisions, or learnings, or when ' +
      'you need historical context across conversations.\n\n' +
      'QUERY SYNTAX (FTS5): bareword: `migration` | phrase: `"WAL corruption"` | ' +
      'boolean: `auth AND token` | prefix: `migrat*` | NOT: `error NOT timeout`.\n\n' +
      'FILTERS: projectFilter (project URI, "@self" for the caller project, "*" for ' +
      'cross-project), tags (hashtags without #).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'FTS5 search query.' },
        projectFilter: {
          type: 'string',
          description:
            'Optional project URI. "@self" -> caller conversation project. "*" -> cross-project recaps (creator-only).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of hashtags to require (without # prefix).',
        },
        limit: { type: 'number', description: 'Max results (1-50, default 10).' },
      },
      required: ['query'],
    },
    async handle(params) {
      if (!hasBrokerRpcSender()) return notConnected()
      const query = String(params.query || '').trim()
      if (!query) return err('query is required')

      const projectFilter = resolveProjectFilter(
        ctx,
        typeof params.projectFilter === 'string' ? params.projectFilter : undefined,
      )
      const tagsRaw = (params as Record<string, unknown>).tags
      const tags = Array.isArray(tagsRaw) ? tagsRaw.map(String).filter(Boolean) : undefined
      const limitRaw = (params as Record<string, unknown>).limit
      const limit = typeof limitRaw === 'number' ? limitRaw : limitRaw ? Number(limitRaw) : undefined

      try {
        const response = await brokerRpc<{ ok: boolean; results?: RecapSearchHit[]; error?: string }>(
          'recap_search_request',
          {
            query,
            ...(projectFilter ? { projectFilter } : {}),
            ...(tags?.length ? { tags } : {}),
            ...(limit && limit > 0 ? { limit } : {}),
          },
        )
        const results = Array.isArray(response.results) ? response.results : []
        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No recaps matched "${query}".` }] }
        }
        const text = [
          `Found ${results.length} recap${results.length === 1 ? '' : 's'} for "${query}"`,
          '',
          ...results.map(formatSearchHit),
          '',
          'Drill in: recap_get({ recapId })',
        ].join('\n\n')
        return { content: [{ type: 'text', text }] }
      } catch (caught) {
        return err(caught instanceof Error ? caught.message : String(caught))
      }
    },
  }
}

function recapGetTool(_ctx: McpToolContext): ToolDef {
  return {
    description:
      'Retrieve the full markdown content and metadata of a specific recap by id. ' +
      'Use after recap_search to read a hit in detail.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        recapId: { type: 'string', description: 'Recap id (recap_xxx...)' },
      },
      required: ['recapId'],
    },
    async handle(params) {
      if (!hasBrokerRpcSender()) return notConnected()
      const recapId = String(params.recapId || '').trim()
      if (!recapId) return err('recapId is required')

      try {
        const response = await brokerRpc<{ ok: boolean; recap?: PeriodRecapDoc; error?: string }>(
          'recap_mcp_get_request',
          { recapId },
        )
        if (!response.recap) return err('recap not found')
        return jsonResult(response.recap)
      } catch (caught) {
        return err(caught instanceof Error ? caught.message : String(caught))
      }
    },
  }
}

function recapListTool(ctx: McpToolContext): ToolDef {
  return {
    description:
      'List recent recaps for a project or across all accessible projects. ' +
      'Use to enumerate history before drilling in with recap_get.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectFilter: {
          type: 'string',
          description: 'Optional project URI. "@self" -> caller conversation project.',
        },
        limit: { type: 'number', description: 'Max results (1-100, default 20).' },
      },
    },
    async handle(params) {
      if (!hasBrokerRpcSender()) return notConnected()
      const projectFilter = resolveProjectFilter(
        ctx,
        typeof params.projectFilter === 'string' ? params.projectFilter : undefined,
      )
      const limitRaw = (params as Record<string, unknown>).limit
      const limit = typeof limitRaw === 'number' ? limitRaw : limitRaw ? Number(limitRaw) : undefined

      try {
        const response = await brokerRpc<{ ok: boolean; recaps?: RecapSummary[]; error?: string }>(
          'recap_mcp_list_request',
          {
            ...(projectFilter ? { projectFilter } : {}),
            ...(limit && limit > 0 ? { limit } : {}),
          },
        )
        const recaps = Array.isArray(response.recaps) ? response.recaps : []
        if (recaps.length === 0) {
          return { content: [{ type: 'text', text: 'No recaps found for this scope.' }] }
        }
        const text = [`${recaps.length} recap${recaps.length === 1 ? '' : 's'}`, '', ...recaps.map(formatSummary)].join(
          '\n\n',
        )
        return { content: [{ type: 'text', text }] }
      } catch (caught) {
        return err(caught instanceof Error ? caught.message : String(caught))
      }
    },
  }
}

function recapCreateTool(ctx: McpToolContext): ToolDef {
  return {
    description:
      'Generate an orientation brief for a fresh Claude Code session: current state, ' +
      'decisions + rationale, dead ends, open questions, next actions. Call this when ' +
      'starting cold in a project, or before spawning a worker. That is the default ' +
      '(audience="agent"); audience="human" produces a narrative report instead. ' +
      'Returns the recap id immediately -- set inform_on_complete to be pushed the ' +
      'result when it finishes, instead of polling recap_get.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectUri: {
          type: 'string',
          description: 'Project URI, "@self" for caller project, or "*" for cross-project.',
        },
        period: {
          type: 'object' as const,
          description: 'Period spec. label is required; start/end (unix ms) required iff label="custom".',
          properties: {
            label: { type: 'string', enum: PERIOD_LABELS },
            start: { type: 'number', description: 'Unix ms (label=custom)' },
            end: { type: 'number', description: 'Unix ms (label=custom)' },
          },
          required: ['label'],
        },
        audience: {
          type: 'string',
          enum: ['agent', 'human'],
          description:
            "'agent' (default) -- terse, high-signal orientation brief for a fresh Claude Code " +
            "session. 'human' -- narrative development report.",
        },
        inform_on_complete: {
          type: 'boolean',
          description:
            'When true, this conversation is pushed a recap-completed channel message when the ' +
            'recap finishes, instead of having to poll recap_get.',
        },
        signals: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional signal subset. Defaults per audience. Values: user_prompts, assistant_final_turn, commits, task_results, tool_summaries, errors_hooks, cost, open_questions, turn_internals',
        },
        force: {
          type: 'boolean',
          description: 'Bypass the 5-min input-hash cache and always regenerate.',
        },
      },
      required: ['projectUri', 'period'],
    },
    async handle(params) {
      if (!hasBrokerRpcSender()) return notConnected()
      const raw = params as Record<string, unknown>
      const projectUriRaw = typeof raw.projectUri === 'string' ? raw.projectUri : ''
      if (!projectUriRaw.trim()) return err('projectUri is required')
      const projectUri =
        projectUriRaw === '*'
          ? '*'
          : projectUriRaw === '@self'
            ? resolveProjectFilter(ctx, '@self') || ''
            : projectUriRaw
      if (!projectUri) return err('cannot resolve @self -- agent host has no identity yet')

      const period = raw.period as { label?: string; start?: number; end?: number } | undefined
      if (!period?.label) return err('period.label is required')
      if (!PERIOD_LABELS.includes(period.label as RecapPeriodLabel)) {
        return err(`invalid period.label: ${period.label}`)
      }
      if (period.label === 'custom' && (typeof period.start !== 'number' || typeof period.end !== 'number')) {
        return err('period.start and period.end (unix ms) are required when label="custom"')
      }

      const signalsRaw = raw.signals
      const signals = Array.isArray(signalsRaw) ? (signalsRaw as RecapSignal[]) : undefined
      const force = Boolean(raw.force)
      const timeZone = resolveTimeZone()
      // The caller of an MCP tool is, by definition, an agent -- default the
      // audience to 'agent'. 'human' must be asked for explicitly.
      const audience = raw.audience === 'human' ? 'human' : 'agent'
      const informOnComplete = raw.inform_on_complete === true

      try {
        const response = await brokerRpc<{ recapId: string; cached: boolean; error?: string }>(
          'recap_create',
          {
            projectUri,
            period,
            timeZone,
            audience,
            ...(signals ? { signals } : {}),
            ...(force ? { force: true } : {}),
            ...(informOnComplete ? { inform_on_complete: true } : {}),
          },
          { timeoutMs: 30_000 },
        )
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  recapId: response.recapId,
                  cached: response.cached,
                  hint: response.cached
                    ? 'Cache hit (existing recap reused). Inspect with recap_get({ recapId }).'
                    : informOnComplete
                      ? 'Recap queued. A recap-completed channel message will be pushed to this conversation when it finishes.'
                      : 'Recap queued. Progress streams to the dashboard. Poll with recap_get({ recapId }) until status="done".',
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (caught) {
        return err(caught instanceof Error ? caught.message : String(caught))
      }
    },
  }
}

export function registerRecapTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    recap_search: recapSearchTool(ctx),
    recap_get: recapGetTool(ctx),
    recap_list: recapListTool(ctx),
    recap_create: recapCreateTool(ctx),
  }
}
