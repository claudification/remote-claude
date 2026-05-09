/**
 * MCP Server endpoint -- exposes Claudwerk tools via Streamable HTTP MCP.
 *
 * External agents (Hermes, etc.) connect to /mcp to use Claudwerk's capabilities:
 * notify, share_file, search_transcripts, send_message, spawn_session,
 * list_conversations, project_list, project_set_status.
 */

import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { BUILD_VERSION } from '../../shared/version'
import { resolveAuth } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import { getGlobalSettings } from '../global-settings'
import { getProjectSettings } from '../project-settings'
import { dispatchSpawn, type SpawnDispatchDeps } from '../spawn-dispatch'
import type { StoreDriver } from '../store/types'

function createMcpServer(conversationStore: ConversationStore, store: StoreDriver): McpServer {
  const mcp = new McpServer(
    { name: 'claudwerk', version: String(BUILD_VERSION || '0.1.0') },
    { capabilities: { tools: {} } },
  )

  // ─── notify ─────────────────────────────────────────────────────────
  mcp.tool(
    'notify',
    "Send a push notification to the user's devices",
    { message: z.string(), title: z.string().optional() },
    async ({ message, title }) => {
      const subscribers = conversationStore.getSubscribers()
      const payload = JSON.stringify({
        type: 'notification',
        title: title || 'Claudwerk',
        body: message,
        timestamp: Date.now(),
      })
      for (const ws of subscribers) {
        try {
          ws.send(payload)
        } catch {
          /* dead socket */
        }
      }
      return { content: [{ type: 'text', text: `Notification sent: ${message}` }] }
    },
  )

  // ─── search_transcripts ─────────────────────────────────────────────
  mcp.tool(
    'search_transcripts',
    'FTS5 search across all conversation transcripts',
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
    'Get transcript entries around a specific sequence number',
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
    'Send a message to another conversation',
    {
      to: z.string().describe('Target conversation scope or name'),
      message: z.string(),
      intent: z.enum(['request', 'response', 'notification']).optional(),
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
    'Spawn a new conversation (coding session or Hermes)',
    {
      cwd: z.string().describe('Working directory'),
      prompt: z.string().optional(),
      name: z.string().optional(),
      model: z.string().optional(),
      backend: z.enum(['claude', 'hermes']).optional(),
      hermesAgentId: z.string().optional(),
      headless: z.boolean().optional(),
    },
    async ({ cwd, prompt, name, model, backend, hermesAgentId, headless }) => {
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
          hermesAgentId,
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
    'List active conversations',
    {
      status: z.enum(['active', 'idle', 'ended', 'all']).optional(),
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
  mcp.tool('project_list', 'List project board tasks', { status: z.string().optional() }, async ({ status }) => {
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

  // Per-session transport map for stateful MCP
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>()

  app.all('/mcp', async c => {
    // Auth: require Bearer token
    const authHeader = c.req.header('authorization')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!bearer) {
      return c.json({ error: 'Authorization required' }, 401)
    }
    const auth = resolveAuth(bearer)
    if (auth.role === 'none') {
      return c.json({ error: 'Invalid token' }, 403)
    }

    // Check for existing session
    const sessionId = c.req.header('mcp-session-id')
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!
      return transport.handleRequest(c.req.raw)
    }

    // New session: create transport + server
    const mcp = createMcpServer(conversationStore, store)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sid => {
        transports.set(sid, transport)
      },
      onsessionclosed: sid => {
        transports.delete(sid)
      },
    })

    await mcp.connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  return app
}
