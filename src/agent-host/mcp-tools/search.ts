/**
 * MCP search tools -- search across transcripts and slide a context window.
 *
 * Both tools call the broker over HTTP. The broker enforces permission gating
 * (caller can only see conversations whose project they have chat:read on).
 */

import { wsToHttpUrl } from '../cli-args'
import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

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
        'Search across conversation transcripts using FTS5 full-text indexing. Returns ranked, highlighted matches with conversation metadata. Use this to find prior discussions, decisions, code, errors, or any context across past or current conversations.\n\n' +
        'QUERY SYNTAX (FTS5):\n' +
        '  - Bareword: `migration`            -- matches that token (porter-stemmed, case-insensitive)\n' +
        '  - Multi-word: `merge conflict`     -- auto-quoted as a phrase\n' +
        '  - Explicit phrase: `"exact words"` -- exact phrase\n' +
        '  - Boolean: `auth AND token`, `slack OR webhook`, `error NOT timeout`\n' +
        '  - Prefix: `migrat*`                -- matches migrate/migration/migrating\n' +
        '  - NEAR: `NEAR(foo bar, 5)`         -- foo within 5 tokens of bar\n' +
        '\n' +
        'FILTERS:\n' +
        '  - conversationId: limit to a specific conversation (most precise)\n' +
        '  - project: filter by project URI. Supports exact match (`claude://default/Users/me/proj`) or glob suffix (`claude://default/Users/me/*` matches anything under that path). Use `*` to match any project.\n' +
        '  - types: filter by entry types (e.g. `["user","assistant"]`, `["tool_use"]`, `["tool_result"]`)\n' +
        '\n' +
        'CONTEXT WINDOW:\n' +
        '  Set windowBefore/windowAfter > 0 to receive surrounding entries with each hit. The window slides on `seq` so it includes the previous N and next N entries in the same conversation.\n' +
        "  After getting results, use `get_transcript_context` with the hit's conversationId + seq to slide further (move the window or expand it).\n" +
        '\n' +
        'PAGINATION: Use `limit` (1-100, default 20) and `offset` to page through results.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description:
              'FTS5 search query. Bareword/phrase/prefix/boolean syntax supported. Multi-word casual queries are auto-quoted as phrases.',
          },
          conversationId: {
            type: 'string',
            description:
              'Limit search to a single conversation ID. Most specific filter. Mutually-precise with project.',
          },
          project: {
            type: 'string',
            description:
              'Filter by project URI. Exact (`claude://default/path`), glob suffix (`claude://default/path/*` matches subtree), or `*` for any.',
          },
          types: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Filter by transcript entry types. Common values: "user", "assistant", "tool_use", "tool_result", "system", "summary".',
          },
          limit: { type: 'number', description: 'Max results (1-100, default 20)' },
          offset: { type: 'number', description: 'Pagination offset (default 0)' },
          windowBefore: {
            type: 'number',
            description:
              'Include N entries immediately before each hit for context (0-10, default 0). Use 2-5 for quick context, then `get_transcript_context` to expand further.',
          },
          windowAfter: {
            type: 'number',
            description: 'Include N entries immediately after each hit for context (0-10, default 0).',
          },
        },
        required: ['query'],
      },
      async handle(params) {
        const http = brokerHttp()
        if (!http) return { content: [{ type: 'text', text: 'Error: broker not available' }], isError: true }
        const query = String(params.query || '').trim()
        if (!query) return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true }

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
        if (params.windowBefore != null) {
          url.searchParams.set('windowBefore', String(Math.min(parseInt(String(params.windowBefore), 10) || 0, 10)))
        }
        if (params.windowAfter != null) {
          url.searchParams.set('windowAfter', String(Math.min(parseInt(String(params.windowAfter), 10) || 0, 10)))
        }

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
          const data = await res.json()
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown'
          debug(`[channel] search_transcripts error: ${msg}`)
          return { content: [{ type: 'text', text: `Search request failed: ${msg}` }], isError: true }
        }
      },
    },

    get_transcript_context: {
      description:
        'Get a sliding window of transcript entries around a specific point in a conversation. Use after `search_transcripts` to expand context around a hit, or to walk through a conversation by repeatedly shifting `aroundSeq`.\n\n' +
        'CENTERING:\n' +
        '  - aroundSeq: center on a specific sequence number (preferred -- stable across the conversation lifetime)\n' +
        '  - aroundId: center on a specific entry id (database row id)\n' +
        '\n' +
        'SLIDING:\n' +
        '  Adjust `before` and `after` (each 0-50) to expand/shrink the window. To move forward, call again with aroundSeq = lastReturned.seq. To move backward, aroundSeq = firstReturned.seq.\n' +
        '\n' +
        'TYPICAL USAGE: Start with before=5, after=5. If results are partial, expand to before=20, after=20. To walk a conversation, repeat with shifted aroundSeq.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          conversationId: { type: 'string', description: 'Conversation to read from' },
          aroundSeq: {
            type: 'number',
            description: 'Center the window on this sequence number (preferred). Get this from search hits.',
          },
          aroundId: {
            type: 'number',
            description: 'Center the window on this entry id. Use aroundSeq when possible -- ids are storage-internal.',
          },
          before: { type: 'number', description: 'Entries before center (0-50, default 5)' },
          after: { type: 'number', description: 'Entries after center (0-50, default 5)' },
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
