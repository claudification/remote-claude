/**
 * MCP Server endpoint -- exposes Claudwerk tools via Streamable HTTP MCP.
 *
 * External agents (Chat API, etc.) connect to /mcp to use Claudwerk's capabilities:
 * notify, share_file, search_transcripts, send_message, spawn_session,
 * list_conversations, project_list, project_set_status.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { BUILD_VERSION } from '../../shared/version'
import { resolveAuth } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import { getGlobalSettings } from '../global-settings'
import { getProjectSettings } from '../project-settings'
import { isPushConfigured, sendPushToAll } from '../push'
import { dispatchSpawn, type SpawnDispatchDeps } from '../spawn-dispatch'
import type { StoreDriver } from '../store/types'

function createMcpServer(conversationStore: ConversationStore, store: StoreDriver): McpServer {
  const mcp = new McpServer(
    { name: 'claudwerk', version: BUILD_VERSION?.gitHashShort || '0.1.0' },
    { capabilities: { tools: {} } },
  )

  // ─── notify ─────────────────────────────────────────────────────────
  mcp.tool(
    'notify',
    "Send a push notification to the user's registered devices (phone, browser). Use when a long-running task completes or you need the user's attention. Delivered via VAPID web-push to all subscribed devices AND broadcast to live dashboard sockets.",
    { message: z.string(), title: z.string().optional() },
    async ({ message, title }) => {
      const wsPayload = JSON.stringify({
        type: 'notification',
        title: title || 'Claudwerk',
        body: message,
        timestamp: Date.now(),
      })
      let wsDelivered = 0
      for (const ws of conversationStore.getSubscribers()) {
        try {
          ws.send(wsPayload)
          wsDelivered++
        } catch {
          /* dead socket */
        }
      }

      let pushSent = 0
      let pushFailed = 0
      if (isPushConfigured()) {
        const result = await sendPushToAll({
          title: title || 'Claudwerk',
          body: message,
        })
        pushSent = result.sent
        pushFailed = result.failed
      }

      return {
        content: [
          {
            type: 'text',
            text: `Notification dispatched: ws=${wsDelivered}, push_sent=${pushSent}, push_failed=${pushFailed}`,
          },
        ],
      }
    },
  )

  // ─── search_transcripts ─────────────────────────────────────────────
  mcp.tool(
    'search_transcripts',
    "FTS5 full-text search across every conversation transcript stored by the broker. Use to find prior decisions, code snippets, or context from past conversations. Default `output: \"conversations\"` returns one row per matching conversation; `output: \"snippets\"` returns the actual matching transcript entries with seq numbers (feed seq into get_transcript_context to expand).",
    {
      query: z.string(),
      output: z.enum(['conversations', 'snippets']).optional(),
      limit: z.number().optional(),
    },
    async ({ query, output, limit }) => {
      const hits = store.transcripts.search(query, { limit: limit || 20 })
      if (output === 'snippets') {
        const snippets = hits.map(h => ({
          conversationId: h.conversationId,
          seq: h.seq,
          type: h.type,
          snippet: h.snippet,
          timestamp: h.timestamp,
        }))
        return { content: [{ type: 'text', text: JSON.stringify(snippets, null, 2) }] }
      }
      // Group by conversation
      const convMap = new Map<string, { count: number; topSnippet: string }>()
      for (const h of hits) {
        const existing = convMap.get(h.conversationId)
        if (existing) {
          existing.count++
        } else {
          convMap.set(h.conversationId, { count: 1, topSnippet: h.snippet })
        }
      }
      const conversations = Array.from(convMap.entries()).map(([id, data]) => {
        const conv = conversationStore.getConversation(id)
        return {
          conversationId: id,
          title: conv?.title,
          project: conv?.project,
          status: conv?.status,
          matchCount: data.count,
          topSnippet: data.topSnippet,
        }
      })
      return { content: [{ type: 'text', text: JSON.stringify(conversations, null, 2) }] }
    },
  )

  // ─── get_transcript_context ─────────────────────────────────────────
  mcp.tool(
    'get_transcript_context',
    'Sliding window of transcript entries around a given seq number. Use after search_transcripts (with output:"snippets") to expand context around a hit -- pass the conversationId and seq from the search result.',
    {
      conversationId: z.string(),
      seq: z.number(),
      window: z.number().optional(),
    },
    async ({ conversationId, seq, window: windowSize }) => {
      const entries = store.transcripts.getWindow(conversationId, {
        aroundSeq: seq,
        before: windowSize || 5,
        after: windowSize || 5,
      })
      return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] }
    },
  )

  // ─── send_message ───────────────────────────────────────────────────
  mcp.tool(
    'send_message',
    "Send a message to another conversation (CC, Hermes, chat-api, etc.). The recipient sees the message wrapped in a <channel> tag with the from/intent/conversation_id attributes preserved -- they reply by calling this tool back with the same conversation_id. Use for delegating subtasks, asking sibling agents for help, or relaying findings.",
    {
      to: z.string().describe('Target conversation ID, title, or agent name. For replies, use the from_session value from the incoming <channel> wrapper.'),
      message: z.string().describe('Message body. Markdown is fine; the recipient sees it inside <channel>...</channel>.'),
      intent: z.enum(['request', 'response', 'notification']).optional().describe('request=needs answer, response=replying to them, notification=FYI no answer expected'),
    },
    async ({ to, message, intent }) => {
      // Resolve target -- could be a conversation ID or a scope slug
      const conversations = conversationStore.getAllConversations()
      const target = conversations.find(c => c.id === to || c.title === to || c.agentName === to)
      if (target) {
        const ws = conversationStore.getConversationSocket(target.id)
        if (ws) {
          ws.send(
            JSON.stringify({
              type: 'inter_session_message',
              from: 'mcp-client',
              message,
              intent: intent || 'notification',
            }),
          )
          return { content: [{ type: 'text', text: `Message sent to ${target.title || target.id}` }] }
        }
      }
      return { content: [{ type: 'text', text: `Target "${to}" not found or not connected` }] }
    },
  )

  // ─── spawn_session ──────────────────────────────────────────────────
  mcp.tool(
    'spawn_session',
    'Spawn a new conversation (a fresh Claude Code session or chat-api worker). Use when the user asks to "delegate this", "start a new session", or when a task needs an isolated context. Returns the conversationId so you can send_message to coordinate with it.',
    {
      cwd: z.string().describe('Absolute working directory for the spawned session.'),
      prompt: z.string().optional().describe('Initial user prompt for the spawned agent.'),
      name: z.string().optional().describe('Display name for the conversation (auto-generated if omitted).'),
      model: z.string().optional().describe('Model override. Otherwise uses the project default.'),
      backend: z.enum(['claude', 'chat-api']).optional().describe('claude=Claude Code (with tools); chat-api=plain LLM via OpenRouter/etc.'),
      chatConnectionId: z.string().optional().describe('For backend=chat-api, which configured connection to use.'),
      headless: z.boolean().optional().describe('Default true. Headless sessions run without a visible terminal.'),
    },
    async ({ cwd, prompt, name, model, backend, chatConnectionId, headless }) => {
      const callerContext = {
        kind: 'mcp' as const,
        hasSpawnPermission: true,
        trustLevel: 'trusted' as const,
        callerProject: null,
      }
      const deps: SpawnDispatchDeps = {
        conversationStore,
        getProjectSettings,
        getGlobalSettings,
        callerContext,
      }
      const result = await dispatchSpawn(
        {
          cwd,
          prompt,
          name,
          model,
          backend,
          chatConnectionId,
          headless: headless ?? true,
        },
        deps,
      )
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Spawn failed: ${result.error}` }], isError: true }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ conversationId: result.conversationId, jobId: result.jobId }),
          },
        ],
      }
    },
  )

  // ─── list_conversations ─────────────────────────────────────────────
  mcp.tool(
    'list_conversations',
    "List Claudwerk conversations (CC, Hermes, chat-api). Default excludes ended sessions. Pass status:'all' to see the full graveyard. Returns conversationId, title, project, status, model, agentHostType, startedAt, lastActivity for each.",
    {
      status: z.enum(['active', 'idle', 'ended', 'all']).optional().describe("Filter. Default = active+idle (everything not ended)."),
    },
    async ({ status }) => {
      let conversations = conversationStore.getAllConversations()
      if (status && status !== 'all') {
        conversations = conversations.filter(c => c.status === status)
      } else if (!status) {
        conversations = conversations.filter(c => c.status !== 'ended')
      }
      const summary = conversations.map(c => ({
        conversationId: c.id,
        title: c.title,
        project: c.project,
        status: c.status,
        model: c.model,
        agentHostType: c.agentHostType,
        startedAt: c.startedAt,
        lastActivity: c.lastActivity,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
    },
  )

  // ─── project_list ───────────────────────────────────────────────────
  mcp.tool(
    'project_list',
    "List tasks on the user's kanban-style project board. Status columns: inbox, open, in-progress, in-review, done, archived. Each task has id, title, priority, tags, refs.",
    { status: z.string().optional().describe('Filter by column. Omit for all tasks.') },
    async ({ status }) => {
    // Read from project board files
    const tasks = store.kv.get<Record<string, unknown>[]>('project:tasks') || []
    const filtered = status ? tasks.filter(t => t.status === status) : tasks
    return { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] }
  })

  // ─── project_set_status ─────────────────────────────────────────────
  mcp.tool(
    'project_set_status',
    'Move a project task between status columns',
    {
      id: z.string().describe('Task ID (filename without .md)'),
      status: z.string().describe('Target status (inbox, open, in-progress, in-review, done, archived)'),
    },
    async ({ id, status: newStatus }) => {
      // Update task status in KV store
      const tasks = store.kv.get<Record<string, unknown>[]>('project:tasks') || []
      const task = tasks.find(t => t.id === id)
      if (!task) {
        return { content: [{ type: 'text', text: `Task "${id}" not found` }], isError: true }
      }
      task.status = newStatus
      store.kv.set('project:tasks', tasks)
      return { content: [{ type: 'text', text: `Task "${id}" moved to ${newStatus}` }] }
    },
  )

  return mcp
}

export function createMcpRouter(
  conversationStore: ConversationStore,
  store: StoreDriver,
  _rclaudeSecret?: string,
): Hono {
  const app = new Hono()

  // Stateless mode: no session tracking, JSON responses (no SSE).
  // Tools are pure request/response with no server-initiated notifications,
  // so we don't need session state or long-lived SSE streams. Stateful mode
  // would force clients to open a standalone GET SSE stream that the server
  // never writes to, causing client-side read timeouts (~5min) that kill the
  // anyio TaskGroup and break subsequent tool calls. See Hermes incident
  // 2026-05-10: "MCP server 'claudwerk' connection lost ... unhandled errors
  // in a TaskGroup".
  app.all('/mcp', async c => {
    const authHeader = c.req.header('authorization')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!bearer) {
      return c.json({ error: 'Authorization required' }, 401)
    }
    const auth = resolveAuth(bearer)
    if (auth.role === 'none') {
      return c.json({ error: 'Invalid token' }, 403)
    }

    const mcp = createMcpServer(conversationStore, store)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    try {
      await mcp.connect(transport)
      return await transport.handleRequest(c.req.raw)
    } finally {
      await transport.close().catch(() => {})
      await mcp.close().catch(() => {})
    }
  })

  return app
}
