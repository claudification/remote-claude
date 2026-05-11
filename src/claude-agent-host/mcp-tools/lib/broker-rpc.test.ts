import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetBrokerRpc,
  brokerRpc,
  brokerRpcPendingCount,
  clearBrokerRpcPending,
  dispatchBrokerRpcResponse,
  hasBrokerRpcSender,
  setBrokerRpcSender,
} from './broker-rpc'

describe('broker-rpc', () => {
  beforeEach(() => {
    _resetBrokerRpc()
  })
  afterEach(() => {
    _resetBrokerRpc()
  })

  test('rejects when no sender is registered', async () => {
    expect(hasBrokerRpcSender()).toBe(false)
    expect(brokerRpc('test_type', {})).rejects.toThrow('broker not connected')
  })

  test('hasBrokerRpcSender flips on/off with setBrokerRpcSender', () => {
    expect(hasBrokerRpcSender()).toBe(false)
    setBrokerRpcSender(() => {})
    expect(hasBrokerRpcSender()).toBe(true)
    setBrokerRpcSender(null)
    expect(hasBrokerRpcSender()).toBe(false)
  })

  test('sends a message with type, requestId, and payload', async () => {
    const captured: Array<Record<string, unknown>> = []
    setBrokerRpcSender(msg => captured.push(msg as unknown as Record<string, unknown>))

    const promise = brokerRpc('foo_request', { x: 1, y: 'two' })
    expect(captured).toHaveLength(1)
    const sent = captured[0]
    expect(sent.type).toBe('foo_request')
    expect(typeof sent.requestId).toBe('string')
    expect((sent.requestId as string).length).toBeGreaterThan(8)
    expect(sent.x).toBe(1)
    expect(sent.y).toBe('two')

    dispatchBrokerRpcResponse({ type: 'foo_response', requestId: sent.requestId, ok: true, data: 42 })
    const resolved = await promise
    expect(resolved.data).toBe(42)
  })

  test('multiple in-flight requests resolve independently', async () => {
    const captured: Array<Record<string, unknown>> = []
    setBrokerRpcSender(msg => captured.push(msg as unknown as Record<string, unknown>))

    const a = brokerRpc('alpha', { v: 'a' })
    const b = brokerRpc('beta', { v: 'b' })
    expect(brokerRpcPendingCount()).toBe(2)

    const idA = captured[0].requestId as string
    const idB = captured[1].requestId as string
    expect(idA).not.toBe(idB)

    dispatchBrokerRpcResponse({ requestId: idB, ok: true, value: 'B' })
    dispatchBrokerRpcResponse({ requestId: idA, ok: true, value: 'A' })

    const [resA, resB] = await Promise.all([a, b])
    expect(resA.value).toBe('A')
    expect(resB.value).toBe('B')
    expect(brokerRpcPendingCount()).toBe(0)
  })

  test('rejects on ok:false with error string', async () => {
    setBrokerRpcSender(() => {})
    const captured: Array<Record<string, unknown>> = []
    setBrokerRpcSender(msg => captured.push(msg as unknown as Record<string, unknown>))

    const promise = brokerRpc('thing')
    const id = captured[0].requestId as string
    dispatchBrokerRpcResponse({ requestId: id, ok: false, error: 'permission denied' })
    await expect(promise).rejects.toThrow('permission denied')
  })

  test('rejects on response with bare error field (no ok)', async () => {
    const captured: Array<Record<string, unknown>> = []
    setBrokerRpcSender(msg => captured.push(msg as unknown as Record<string, unknown>))

    const promise = brokerRpc('thing')
    const id = captured[0].requestId as string
    dispatchBrokerRpcResponse({ requestId: id, error: 'orchestrator down' })
    await expect(promise).rejects.toThrow('orchestrator down')
  })

  test('rejects on timeout', async () => {
    const captured: Array<Record<string, unknown>> = []
    setBrokerRpcSender(msg => captured.push(msg as unknown as Record<string, unknown>))

    const promise = brokerRpc('slow_thing', {}, { timeoutMs: 30 })
    await expect(promise).rejects.toThrow(/timeout \(30ms\)/)
    expect(brokerRpcPendingCount()).toBe(0)
  })

  test('dispatch returns false for unknown requestId', () => {
    expect(dispatchBrokerRpcResponse({ requestId: 'nope', ok: true })).toBe(false)
  })

  test('dispatch returns false for missing requestId', () => {
    expect(dispatchBrokerRpcResponse({ ok: true })).toBe(false)
  })

  test('dispatch returns true and consumes the entry only once', async () => {
    const captured: Array<Record<string, unknown>> = []
    setBrokerRpcSender(msg => captured.push(msg as unknown as Record<string, unknown>))

    const promise = brokerRpc('thing')
    const id = captured[0].requestId as string

    expect(dispatchBrokerRpcResponse({ requestId: id, ok: true, x: 1 })).toBe(true)
    expect(dispatchBrokerRpcResponse({ requestId: id, ok: true, x: 2 })).toBe(false)
    const result = await promise
    expect(result.x).toBe(1)
  })

  test('clearBrokerRpcPending rejects all in-flight requests', async () => {
    const captured: Array<Record<string, unknown>> = []
    setBrokerRpcSender(msg => captured.push(msg as unknown as Record<string, unknown>))

    const a = brokerRpc('alpha', {}, { timeoutMs: 5000 })
    const b = brokerRpc('beta', {}, { timeoutMs: 5000 })
    expect(brokerRpcPendingCount()).toBe(2)

    clearBrokerRpcPending('disconnected')

    await expect(a).rejects.toThrow('disconnected')
    await expect(b).rejects.toThrow('disconnected')
    expect(brokerRpcPendingCount()).toBe(0)
  })

  test('rejects synchronously when send throws', async () => {
    setBrokerRpcSender(() => {
      throw new Error('socket closed')
    })
    await expect(brokerRpc('thing')).rejects.toThrow('socket closed')
    expect(brokerRpcPendingCount()).toBe(0)
  })
})
