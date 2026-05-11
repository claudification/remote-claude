import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { _resetBrokerRpc, dispatchBrokerRpcResponse, setBrokerRpcSender } from './lib/broker-rpc'
import { registerRecapTools } from './recap'
import type { AgentHostIdentity, McpToolContext, ToolDef } from './types'

function buildCtx(opts: { identity?: AgentHostIdentity | null } = {}): McpToolContext {
  return {
    callbacks: {},
    getIdentity: () => opts.identity ?? null,
    getClaudeCodeVersion: () => '0.0.0',
    getDialogCwd: () => '/tmp',
    pendingDialogs: new Map(),
    elog: () => {},
  }
}

function tools() {
  return registerRecapTools(buildCtx({ identity: identityFor('/Users/jonas/projects/foo') }))
}

function identityFor(cwd: string): AgentHostIdentity {
  return {
    ccSessionId: 'cc_xx',
    conversationId: 'conv_xx',
    cwd,
    headless: true,
  }
}

interface CapturedSend {
  type: string
  requestId: string
  payload: Record<string, unknown>
}

function captureSends(): { sent: CapturedSend[] } {
  const sent: CapturedSend[] = []
  setBrokerRpcSender(msg => {
    const m = msg as unknown as Record<string, unknown>
    sent.push({
      type: String(m.type),
      requestId: String(m.requestId),
      payload: m,
    })
  })
  return { sent }
}

async function callTool(
  tool: ToolDef,
  params: Record<string, unknown>,
  reply?: (requestId: string) => Record<string, unknown>,
) {
  const cap = captureSends()
  if (reply) {
    setBrokerRpcSender(msg => {
      const m = msg as unknown as Record<string, unknown>
      cap.sent.push({ type: String(m.type), requestId: String(m.requestId), payload: m })
      const response = reply(String(m.requestId))
      queueMicrotask(() => {
        dispatchBrokerRpcResponse({ requestId: m.requestId, ...response })
      })
    })
  }
  const result = await tool.handle(params as Record<string, string>, { rawArgs: params, extra: {} })
  return { result, sent: cap.sent }
}

describe('recap MCP tools registration', () => {
  beforeEach(() => _resetBrokerRpc())
  afterEach(() => _resetBrokerRpc())

  test('exposes the four expected tool names', () => {
    const t = tools()
    expect(Object.keys(t).sort()).toEqual(['recap_create', 'recap_get', 'recap_list', 'recap_search'])
  })

  test('all tools have a description and inputSchema', () => {
    for (const [name, def] of Object.entries(tools())) {
      expect(def.description.length).toBeGreaterThan(20)
      expect(def.inputSchema).toBeDefined()
      expect((def.inputSchema as { type: string }).type).toBe('object')
      expect(name).toMatch(/^recap_/)
    }
  })
})

describe('recap_search', () => {
  beforeEach(() => _resetBrokerRpc())
  afterEach(() => _resetBrokerRpc())

  test('errors when broker is not connected', async () => {
    const t = tools()
    const result = await t.recap_search.handle({ query: 'foo' } as Record<string, string>, { rawArgs: {}, extra: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('broker connection not ready')
  })

  test('errors when query is empty', async () => {
    captureSends()
    const t = tools()
    const result = await t.recap_search.handle({ query: '   ' } as Record<string, string>, { rawArgs: {}, extra: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('query is required')
  })

  test('sends recap_search_request with the right payload', async () => {
    const t = tools()
    const { result, sent } = await callTool(t.recap_search, { query: 'sqlite migration', limit: 5 }, () => ({
      ok: true,
      results: [],
    }))
    expect(result.isError).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('recap_search_request')
    expect(sent[0].payload.query).toBe('sqlite migration')
    expect(sent[0].payload.limit).toBe(5)
    expect(sent[0].payload.projectFilter).toBeUndefined()
  })

  test('resolves @self projectFilter to the agent host project URI', async () => {
    const ctx = buildCtx({ identity: identityFor('/Users/jonas/projects/foo') })
    const t = registerRecapTools(ctx)
    const { sent } = await callTool(t.recap_search, { query: 'x', projectFilter: '@self' }, () => ({
      ok: true,
      results: [],
    }))
    expect(sent[0].payload.projectFilter).toBe('claude://default/Users/jonas/projects/foo')
  })

  test('passes through "*" projectFilter unchanged', async () => {
    const t = tools()
    const { sent } = await callTool(t.recap_search, { query: 'x', projectFilter: '*' }, () => ({
      ok: true,
      results: [],
    }))
    expect(sent[0].payload.projectFilter).toBe('*')
  })

  test('formats matched hits as readable text', async () => {
    const t = tools()
    const { result } = await callTool(t.recap_search, { query: 'wal' }, () => ({
      ok: true,
      results: [
        {
          id: 'recap_aaa',
          projectUri: 'claude://default/x',
          periodLabel: 'last_7',
          periodStart: 1714867200000,
          periodEnd: 1715472000000,
          title: 'remote-claude - Last 7 days',
          subtitle: 'WAL incident + Phase 4',
          snippet: 'docker cp <mark>WAL</mark> corruption',
          score: 0.42,
          createdAt: 1715472000000,
        },
      ],
    }))
    const text = result.content[0].text
    expect(text).toContain('Found 1 recap for "wal"')
    expect(text).toContain('recap_aaa')
    expect(text).toContain('WAL incident')
    expect(text).toContain('docker cp *WAL* corruption')
  })

  test('handles empty results gracefully', async () => {
    const t = tools()
    const { result } = await callTool(t.recap_search, { query: 'nope' }, () => ({ ok: true, results: [] }))
    expect(result.content[0].text).toBe('No recaps matched "nope".')
  })

  test('propagates broker errors', async () => {
    const t = tools()
    const { result } = await callTool(t.recap_search, { query: 'foo' }, () => ({
      ok: false,
      error: 'permission denied',
    }))
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('permission denied')
  })
})

describe('recap_get', () => {
  beforeEach(() => _resetBrokerRpc())
  afterEach(() => _resetBrokerRpc())

  test('errors when recapId is missing', async () => {
    captureSends()
    const t = tools()
    const result = await t.recap_get.handle({ recapId: '' } as Record<string, string>, { rawArgs: {}, extra: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('recapId is required')
  })

  test('returns full recap JSON on success', async () => {
    const t = tools()
    const recap = {
      recapId: 'recap_zz',
      projectUri: 'claude://default/p',
      periodLabel: 'today',
      periodStart: 0,
      periodEnd: 1,
      timeZone: 'UTC',
      status: 'done',
      progress: 100,
      inputChars: 0,
      inputTokens: 0,
      outputTokens: 0,
      llmCostUsd: 0,
      createdAt: 0,
      markdown: '# hello',
    }
    const { result, sent } = await callTool(t.recap_get, { recapId: 'recap_zz' }, () => ({ ok: true, recap }))
    expect(sent[0].type).toBe('recap_mcp_get_request')
    expect(sent[0].payload.recapId).toBe('recap_zz')
    expect(JSON.parse(result.content[0].text)).toEqual(recap)
  })

  test('errors when broker reports recap not found', async () => {
    const t = tools()
    const { result } = await callTool(t.recap_get, { recapId: 'recap_x' }, () => ({ ok: true, recap: null }))
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('recap not found')
  })
})

describe('recap_list', () => {
  beforeEach(() => _resetBrokerRpc())
  afterEach(() => _resetBrokerRpc())

  test('sends recap_mcp_list_request and prints summary list', async () => {
    const t = tools()
    const { result, sent } = await callTool(t.recap_list, { limit: 3 }, () => ({
      ok: true,
      recaps: [
        {
          id: 'recap_1',
          projectUri: 'claude://default/p',
          periodLabel: 'today',
          periodStart: 1715000000000,
          periodEnd: 1715086400000,
          status: 'done',
          title: 'Today',
          subtitle: 'minor cleanup',
          createdAt: 1715086400000,
          llmCostUsd: 0.012,
          progress: 100,
        },
      ],
    }))
    expect(sent[0].type).toBe('recap_mcp_list_request')
    expect(sent[0].payload.limit).toBe(3)
    expect(result.content[0].text).toContain('1 recap')
    expect(result.content[0].text).toContain('recap_1')
    expect(result.content[0].text).toContain('$0.0120')
  })

  test('renders friendly message when empty', async () => {
    const t = tools()
    const { result } = await callTool(t.recap_list, {}, () => ({ ok: true, recaps: [] }))
    expect(result.content[0].text).toContain('No recaps found')
  })
})

describe('recap_create', () => {
  beforeEach(() => _resetBrokerRpc())
  afterEach(() => _resetBrokerRpc())

  test('errors when projectUri is missing', async () => {
    captureSends()
    const t = tools()
    const result = await t.recap_create.handle(
      { projectUri: '', period: { label: 'today' } } as unknown as Record<string, string>,
      { rawArgs: {}, extra: {} },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('projectUri is required')
  })

  test('errors when period.label is missing', async () => {
    captureSends()
    const t = tools()
    const result = await t.recap_create.handle(
      { projectUri: '@self', period: {} } as unknown as Record<string, string>,
      { rawArgs: {}, extra: {} },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('period.label is required')
  })

  test('errors when period.label is invalid', async () => {
    captureSends()
    const t = tools()
    const result = await t.recap_create.handle(
      { projectUri: '*', period: { label: 'next_week' } } as unknown as Record<string, string>,
      { rawArgs: {}, extra: {} },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('invalid period.label')
  })

  test('errors when custom period missing start/end', async () => {
    captureSends()
    const t = tools()
    const result = await t.recap_create.handle(
      { projectUri: '*', period: { label: 'custom' } } as unknown as Record<string, string>,
      { rawArgs: {}, extra: {} },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('start and period.end')
  })

  test('@self requires identity to be set', async () => {
    captureSends()
    const ctx = buildCtx({ identity: null })
    const t = registerRecapTools(ctx)
    const result = await t.recap_create.handle(
      { projectUri: '@self', period: { label: 'today' } } as unknown as Record<string, string>,
      { rawArgs: {}, extra: {} },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('cannot resolve @self')
  })

  test('sends recap_create with timeZone + echoed requestId, returns recapId', async () => {
    const t = tools()
    const { result, sent } = await callTool(
      t.recap_create,
      { projectUri: '*', period: { label: 'last_7' }, force: true },
      requestId => ({ recapId: 'recap_yy', cached: false, requestId }),
    )
    expect(sent[0].type).toBe('recap_create')
    expect(sent[0].payload.projectUri).toBe('*')
    expect(sent[0].payload.force).toBe(true)
    expect(typeof sent[0].payload.timeZone).toBe('string')
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.recapId).toBe('recap_yy')
    expect(parsed.cached).toBe(false)
  })

  test('cache hit hint differs from queued hint', async () => {
    const t = tools()
    const { result } = await callTool(t.recap_create, { projectUri: '*', period: { label: 'today' } }, requestId => ({
      recapId: 'recap_aa',
      cached: true,
      requestId,
    }))
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.cached).toBe(true)
    expect(parsed.hint).toContain('Cache hit')
  })

  test('@self projectUri resolves to caller project', async () => {
    const ctx = buildCtx({ identity: identityFor('/Users/jonas/projects/bar') })
    const t = registerRecapTools(ctx)
    const { sent } = await callTool(t.recap_create, { projectUri: '@self', period: { label: 'today' } }, requestId => ({
      recapId: 'recap_bb',
      cached: false,
      requestId,
    }))
    expect(sent[0].payload.projectUri).toBe('claude://default/Users/jonas/projects/bar')
  })

  test('propagates broker error when recap_error returned with requestId', async () => {
    const t = tools()
    const { result } = await callTool(t.recap_create, { projectUri: '*', period: { label: 'today' } }, requestId => ({
      error: 'orchestrator down',
      requestId,
    }))
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('orchestrator down')
  })
})
