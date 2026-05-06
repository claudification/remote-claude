/**
 * MCP search tools -- progressive transcript search.
 *
 * Designed for minimal context consumption:
 *   1. search_transcripts (conversations mode) -> which conversations match?
 *   2. search_transcripts (snippets mode, + conversationId) -> matches within a conversation
 *   3. get_transcript_context (aroundSeq) -> full content window around a hit
 *
 * Both tools call the broker over HTTP. The broker enforces permission gating.
 */

import { wsToHttpUrl } from '../cli-args'
import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

interface SearchHit {
  id: number
  conversationId: string
  seq: number
  type: string
  subtype?: string
  snippet: string
  score: number
  content: unknown
  createdAt: number
  conversation?: { id: string; project?: string; title?: string; description?: string }
  window?: unknown[]
}

interface SearchResponse {
  hits: SearchHit[]
  total: number
  query: string
  limit: number
  offset: number
}

function formatConversationsOutput(data: SearchResponse): string {
  const grouped = new Map<string, { conv: SearchHit['conversation']; hits: SearchHit[]; bestScore: number }>()

  for (const hit of data.hits) {
    const cid = hit.conversationId
    const existing = grouped.get(cid)
    if (existing) {
      existing.hits.push(hit)
      if (hit.score < existing.bestScore) existing.bestScore = hit.score
    } else {
      grouped.set(cid, { conv: hit.conversation, hits: [hit], bestScore: hit.score })
    }
  }

  const lines: string[] = [`Found ${data.total} hits across ${grouped.size} conversations for "${data.query}"`, '']

  for (const [cid, group] of grouped) {
    const title = group.conv?.title || 'untitled'
    const project = group.conv?.project || ''
    const shortProject = project
    lines.push(`[${cid}] ${title}`)
    lines.push(`  project: ${shortProject}  |  hits: ${group.hits.length}`)
    const best = group.hits[0]
    if (best?.snippet) {
      const clean = best.snippet
        .replace(/<\/?mark>/g, '*')
        .replace(/\.\.\./g, '...')
        .trim()
      lines.push(`  best match: ${clean}`)
    }
    lines.push('')
  }

  lines.push('Drill in: search_transcripts({ query, conversationId, output: "snippets" })')
  return lines.join('\n')
}

function formatSnippetsOutput(data: SearchResponse): string {
  const lines: string[] = [`${data.total} matches for "${data.query}" (offset ${data.offset}, limit ${data.limit})`, '']

  for (const hit of data.hits) {
    const convTitle = hit.conversation?.title || ''
    const ts = hit.createdAt ? new Date(hit.createdAt).toISOString().replace('T', ' ').slice(0, 19) : ''
    const clean = (hit.snippet || '')
      .replace(/<\/?mark>/g, '*')
      .replace(/\.\.\./g, '...')
      .trim()

    lines.push(`seq ${hit.seq}  |  ${hit.type}${hit.subtype ? '/' + hit.subtype : ''}  |  ${ts}  |  ${convTitle}`)
    lines.push(`  conv: ${hit.conversationId}`)
    if (clean) lines.push(`  ${clean}`)
    lines.push('')
  }

  lines.push('Expand: get_transcript_context({ conversationId, aroundSeq })')
  return lines.join('\n')
}

export function registerSearchTools(ctx: McpToolContext): Record<string, ToolDef> {
  function authHeaders(): Record<string, string> {
    return ctx.brokerSecret ? { Authorization: `Bearer ${ctx.brokerSecret}` } : {}
  }

  function brokerHttp(): string | null {
    if (ctx.noBroker || !ctx.brokerUrl) return null
    return wsToHttpUrl(ctx.brokerUrl)
  }

  return {
    search_transcripts: {
      description:
        'Search conversation transcripts (FTS5 full-text). Progressive: start broad, drill in.\n\n' +
        'OUTPUT MODES (progressive disclosure):\n' +
        '  1. "conversations" (default) -- which conversations match? Grouped, compact.\n' +
        '  2. "snippets" -- individual hits with highlighted snippets. Add conversationId to focus.\n' +
        '  3. "full" -- raw transcript entries (large! use sparingly).\n\n' +
        'TYPICAL FLOW:\n' +
        '  search_transcripts({ query: "auth" })                          -> conversations list\n' +
        '  search_transcripts({ query: "auth", conversationId: "abc..." , output: "snippets" }) -> snippets in that conversation\n' +
        '  get_transcript_context({ conversationId: "abc...", aroundSeq: 42 })  -> full content window\n\n' +
        'QUERY SYNTAX (FTS5):\n' +
        '  bareword: `migration` | phrase: `"merge conflict"` | boolean: `auth AND token`\n' +
        '  prefix: `migrat*` | NOT: `error NOT timeout` | NEAR: `NEAR(foo bar, 5)`\n\n' +
        'FILTERS: conversationId, project (URI or glob `path/*`), types (["user","assistant",...]).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'FTS5 search query.',
          },
          output: {
            type: 'string',
            enum: ['conversations', 'snippets', 'full'],
            description:
              'Output mode. "conversations" (default) = grouped by conversation. "snippets" = individual hits. "full" = raw entries.',
          },
          conversationId: {
            type: 'string',
            description: 'Limit to one conversation.',
          },
          project: {
            type: 'string',
            description: 'Filter by project URI (exact or glob suffix `path/*`).',
          },
          types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by entry types: "user", "assistant", "tool_use", "tool_result", etc.',
          },
          limit: { type: 'number', description: 'Max results (1-100, default 20).' },
          offset: { type: 'number', description: 'Pagination offset (default 0).' },
        },
        required: ['query'],
      },
      async handle(params) {
        const http = brokerHttp()
        if (!http) return { content: [{ type: 'text', text: 'Error: broker not available' }], isError: true }
        const query = String(params.query || '').trim()
        if (!query) return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true }

        const output = String(params.output || 'conversations')

        const url = new URL(`${http}/api/search`)
        url.searchParams.set('q', query)
        if (params.conversationId) url.searchParams.set('conversation', String(params.conversationId))
        if (params.project) url.searchParams.set('project', String(params.project))
        if (params.types) {
          const types = Array.isArray(params.types) ? params.types : String(params.types).split(',')
          url.searchParams.set('type', types.map(String).join(','))
        }
        if (params.limit != null) url.searchParams.set('limit', String(params.limit))
        if (params.offset != null) url.searchParams.set('offset', String(params.offset))

        try {
          const res = await fetch(url, { headers: authHeaders() })
          if (!res.ok) {
            const errBody = await res.text().catch(() => '')
            debug(`[channel] search_transcripts: HTTP ${res.status} ${errBody.slice(0, 200)}`)
            return {
              content: [{ type: 'text', text: `Search failed (${res.status}): ${errBody.slice(0, 200) || 'unknown'}` }],
              isError: true,
            }
          }
          const data = (await res.json()) as SearchResponse

          let text: string
          if (output === 'full') {
            text = JSON.stringify(data, null, 2)
          } else if (output === 'snippets') {
            text = formatSnippetsOutput(data)
          } else {
            text = formatConversationsOutput(data)
          }

          return { content: [{ type: 'text', text }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown'
          debug(`[channel] search_transcripts error: ${msg}`)
          return { content: [{ type: 'text', text: `Search request failed: ${msg}` }], isError: true }
        }
      },
    },

    get_transcript_context: {
      description:
        'Sliding window of transcript entries around a point. Use after search_transcripts to read full content.\n\n' +
        'Center on aroundSeq (from search hits) or aroundId. Adjust before/after (0-50) to expand.\n' +
        'To walk forward: set aroundSeq = last returned seq. Backward: aroundSeq = first returned seq.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          conversationId: { type: 'string', description: 'Conversation to read from.' },
          aroundSeq: {
            type: 'number',
            description: 'Center on this sequence number (preferred). From search hit results.',
          },
          aroundId: {
            type: 'number',
            description: 'Center on this entry id (fallback).',
          },
          before: { type: 'number', description: 'Entries before center (0-50, default 5).' },
          after: { type: 'number', description: 'Entries after center (0-50, default 5).' },
        },
        required: ['conversationId'],
      },
      async handle(params) {
        const http = brokerHttp()
        if (!http) return { content: [{ type: 'text', text: 'Error: broker not available' }], isError: true }
        const conversationId = String(params.conversationId || '').trim()
        if (!conversationId) {
          return { content: [{ type: 'text', text: 'Error: conversationId is required' }], isError: true }
        }
        if (params.aroundSeq == null && params.aroundId == null) {
          return { content: [{ type: 'text', text: 'Error: aroundSeq or aroundId required' }], isError: true }
        }

        const url = new URL(`${http}/api/transcript-window`)
        url.searchParams.set('conversation', conversationId)
        if (params.aroundSeq != null) url.searchParams.set('aroundSeq', String(params.aroundSeq))
        if (params.aroundId != null) url.searchParams.set('aroundId', String(params.aroundId))
        if (params.before != null) url.searchParams.set('before', String(params.before))
        if (params.after != null) url.searchParams.set('after', String(params.after))

        try {
          const res = await fetch(url, { headers: authHeaders() })
          if (!res.ok) {
            const errBody = await res.text().catch(() => '')
            debug(`[channel] get_transcript_context: HTTP ${res.status} ${errBody.slice(0, 200)}`)
            return {
              content: [
                { type: 'text', text: `Context fetch failed (${res.status}): ${errBody.slice(0, 200) || 'unknown'}` },
              ],
              isError: true,
            }
          }
          const data = await res.json()
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown'
          debug(`[channel] get_transcript_context error: ${msg}`)
          return { content: [{ type: 'text', text: `Context request failed: ${msg}` }], isError: true }
        }
      },
    },
  }
}
