import { describe, expect, it } from 'bun:test'
import {
  classifyInbound,
  JsonRpcClient,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcWriter,
} from './jsonrpc'

function mkWriter() {
  const lines: string[] = []
  const writer: JsonRpcWriter = { writeLine: l => lines.push(l) }
  return { writer, lines }
}

describe('classifyInbound', () => {
  it('classifies a response (id+result)', () => {
    expect(classifyInbound({ id: 1, result: { ok: true } })).toBe('response')
  })
  it('classifies a response (id+error)', () => {
    expect(classifyInbound({ id: 1, error: { code: -1, message: 'x' } })).toBe('response')
  })
  it('classifies a request (id+method)', () => {
    expect(classifyInbound({ id: 'a', method: 'fs/read_text_file' })).toBe('request')
  })
  it('classifies a notification (method only)', () => {
    expect(classifyInbound({ method: 'session/update' })).toBe('notification')
  })
  it('marks bare objects as invalid', () => {
    expect(classifyInbound({})).toBe('invalid')
  })
  it('treats id:null as no id (per JSON-RPC, null id is for parse errors only)', () => {
    expect(classifyInbound({ id: null, method: 'something' })).toBe('notification')
  })
})

describe('JsonRpcClient.feed line splitting', () => {
  it('handles multiple messages in one chunk', () => {
    const { writer } = mkWriter()
    const seen: JsonRpcNotification[] = []
    const c = new JsonRpcClient({
      writer,
      onRequest: () => {},
      onNotify: n => seen.push(n),
    })
    c.feed(`{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","method":"b"}\n`)
    expect(seen.map(s => s.method)).toEqual(['a', 'b'])
  })

  it('buffers partial lines across feeds', () => {
    const { writer } = mkWriter()
    const seen: JsonRpcNotification[] = []
    const c = new JsonRpcClient({
      writer,
      onRequest: () => {},
      onNotify: n => seen.push(n),
    })
    c.feed('{"jsonrpc":"2.0","met')
    c.feed('hod":"a"}\n{"jsonrpc":"2.0","method":"b"')
    expect(seen.map(s => s.method)).toEqual(['a'])
    c.feed('}\n')
    expect(seen.map(s => s.method)).toEqual(['a', 'b'])
  })

  it('reports parse errors via onInvalid without crashing', () => {
    const { writer } = mkWriter()
    const invalids: Array<{ line: string; reason: string }> = []
    const c = new JsonRpcClient({
      writer,
      onRequest: () => {},
      onNotify: () => {},
      onInvalid: (line, reason) => invalids.push({ line, reason }),
    })
    c.feed('not json\n')
    c.feed('{"jsonrpc":"2.0","method":"ok"}\n')
    expect(invalids).toHaveLength(1)
    expect(invalids[0].reason).toMatch(/parse error/i)
  })

  it('skips blank lines silently', () => {
    const { writer } = mkWriter()
    const invalids: Array<{ line: string; reason: string }> = []
    const c = new JsonRpcClient({
      writer,
      onRequest: () => {},
      onNotify: () => {},
      onInvalid: (line, reason) => invalids.push({ line, reason }),
    })
    c.feed('\n\n   \n')
    expect(invalids).toEqual([])
  })
})

describe('JsonRpcClient.call (client -> agent)', () => {
  it('writes a numbered request, resolves on matching response', async () => {
    const { writer, lines } = mkWriter()
    const c = new JsonRpcClient({ writer, onRequest: () => {}, onNotify: () => {} })
    const promise = c.call<{ ok: boolean }>('initialize')
    expect(lines).toHaveLength(1)
    const req = JSON.parse(lines[0])
    expect(req.jsonrpc).toBe('2.0')
    expect(req.method).toBe('initialize')
    expect(req.id).toBe(1)
    c.feed(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`)
    expect(await promise).toEqual({ ok: true })
    expect(c.pendingCount).toBe(0)
  })

  it('rejects with the rpc error on error response', async () => {
    const { writer } = mkWriter()
    const c = new JsonRpcClient({ writer, onRequest: () => {}, onNotify: () => {} })
    const promise = c.call('boom').catch(e => (e as Error).message)
    c.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } })}\n`)
    expect(await promise).toMatch(/boom rpc error -32601: no such method/)
  })

  it('rejects on timeout', async () => {
    const { writer } = mkWriter()
    const c = new JsonRpcClient({ writer, onRequest: () => {}, onNotify: () => {} })
    const promise = c.call('slow', undefined, 20).catch(e => (e as Error).message)
    expect(await promise).toMatch(/JSON-RPC timeout: slow \(20ms\)/)
  })

  it('rejectAllPending unblocks awaiters', async () => {
    const { writer } = mkWriter()
    const c = new JsonRpcClient({ writer, onRequest: () => {}, onNotify: () => {} })
    const promise = c.call('hang').catch(e => (e as Error).message)
    c.rejectAllPending(new Error('stream closed'))
    expect(await promise).toMatch(/stream closed/)
    expect(c.pendingCount).toBe(0)
  })

  it('numbers ids monotonically across concurrent calls', async () => {
    const { writer, lines } = mkWriter()
    const c = new JsonRpcClient({ writer, onRequest: () => {}, onNotify: () => {} })
    const p1 = c.call('a')
    const p2 = c.call('b')
    expect(JSON.parse(lines[0]).id).toBe(1)
    expect(JSON.parse(lines[1]).id).toBe(2)
    c.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'B' })}\n`)
    c.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'A' })}\n`)
    expect(await p1).toBe('A')
    expect(await p2).toBe('B')
  })
})

describe('JsonRpcClient (agent -> client requests)', () => {
  it('routes incoming requests to onRequest with respond/respondError helpers', () => {
    const { writer, lines } = mkWriter()
    const seen: JsonRpcRequest[] = []
    const c = new JsonRpcClient({
      writer,
      onRequest: (req, respond) => {
        seen.push(req)
        respond({ content: 'ok' })
      },
      onNotify: () => {},
    })
    c.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: '/x' } })}\n`)
    expect(seen).toHaveLength(1)
    expect(lines).toHaveLength(1)
    const out = JSON.parse(lines[0])
    expect(out).toEqual({ jsonrpc: '2.0', id: 7, result: { content: 'ok' } })
  })

  it('respondError emits a structured error response', () => {
    const { writer, lines } = mkWriter()
    const c = new JsonRpcClient({
      writer,
      onRequest: (_req, _respond, respondError) => respondError(-32601, 'nope', { extra: 1 }),
      onNotify: () => {},
    })
    c.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 'abc', method: 'terminal/create' })}\n`)
    expect(JSON.parse(lines[0])).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      error: { code: -32601, message: 'nope', data: { extra: 1 } },
    })
  })

  it('catches handler exceptions and emits a -32603 error', () => {
    const { writer, lines } = mkWriter()
    const c = new JsonRpcClient({
      writer,
      onRequest: () => {
        throw new Error('boom')
      },
      onNotify: () => {},
    })
    c.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'whatever' })}\n`)
    const out = JSON.parse(lines[0])
    expect(out.error.code).toBe(-32603)
    expect(out.error.message).toMatch(/handler threw: boom/)
  })
})

describe('JsonRpcClient.notify', () => {
  it('writes a method-only message without an id', () => {
    const { writer, lines } = mkWriter()
    const c = new JsonRpcClient({ writer, onRequest: () => {}, onNotify: () => {} })
    c.notify('session/update', { sessionUpdate: 'ping' })
    expect(JSON.parse(lines[0])).toEqual({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionUpdate: 'ping' },
    })
  })
})

describe('JsonRpcClient onTrace', () => {
  it('fires on every send + recv (request, response, notification, agent-request, agent-response)', () => {
    const { writer } = mkWriter()
    const trace: Array<{ dir: 'send' | 'recv'; msg: any }> = []
    const c = new JsonRpcClient({
      writer,
      onRequest: (_req, respond) => respond({ ok: true }),
      onNotify: () => {},
      onTrace: (dir, msg) => trace.push({ dir, msg: msg as any }),
    })

    // outbound: client request
    void c.call('initialize', { v: 1 })
    expect(trace).toHaveLength(1)
    expect(trace[0].dir).toBe('send')
    expect(trace[0].msg.method).toBe('initialize')

    // inbound: response to that request
    c.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`)
    expect(trace).toHaveLength(2)
    expect(trace[1].dir).toBe('recv')
    expect((trace[1].msg as any).result).toEqual({ ok: true })

    // inbound: notification
    c.feed(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { x: 1 } })}\n`)
    expect(trace[2].dir).toBe('recv')
    expect((trace[2].msg as any).method).toBe('session/update')

    // inbound: agent request -> our response goes out
    c.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: '/x' } })}\n`)
    // recv (agent request)
    expect(trace[3].dir).toBe('recv')
    expect((trace[3].msg as any).method).toBe('fs/read_text_file')
    // send (our response)
    expect(trace[4].dir).toBe('send')
    expect((trace[4].msg as any).id).toBe(7)
    expect((trace[4].msg as any).result).toEqual({ ok: true })

    // outbound: notification
    c.notify('session/cancel')
    expect(trace[5].dir).toBe('send')
    expect((trace[5].msg as any).method).toBe('session/cancel')
  })
})
