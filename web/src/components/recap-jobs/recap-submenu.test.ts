/**
 * Tests for createRecap (the single entry point for all UI surfaces that
 * dispatch a recap_create over WS). Submenu component rendering is exercised
 * implicitly via the dialog tests; this file pins the WS payload format.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Mock the store so wsSend has a real ws to call.
const sentMessages: Array<{ type: string; data: Record<string, unknown> }> = []

vi.mock('@/hooks/use-conversations', () => ({
  wsSend: (type: string, data?: Record<string, unknown>): boolean => {
    sentMessages.push({ type, data: data || {} })
    return true
  },
}))

// Mock the dialog so importing the submenu module doesn't try to drag in
// react-dom internals during the test.
vi.mock('./recap-custom-range-dialog', () => ({
  openRecapCustomRangeDialog: vi.fn(),
}))

import { createRecap, openRecapHistory } from './recap-submenu'

beforeEach(() => {
  sentMessages.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createRecap', () => {
  test('sends recap_create with timeZone and label', () => {
    const ok = createRecap({ projectUri: 'claude://default/p', label: 'last_7' })
    expect(ok).toBe(true)
    expect(sentMessages).toHaveLength(1)
    const m = sentMessages[0]
    expect(m.type).toBe('recap_create')
    expect(m.data.projectUri).toBe('claude://default/p')
    expect(m.data.period).toEqual({ label: 'last_7' })
    expect(typeof m.data.timeZone).toBe('string')
    expect((m.data.timeZone as string).length).toBeGreaterThan(0)
  })

  test('cross-project ("*") payload', () => {
    createRecap({ projectUri: '*', label: 'today' })
    expect(sentMessages[0].data.projectUri).toBe('*')
  })

  test('custom range requires start + end (returns false otherwise)', () => {
    const ok = createRecap({ projectUri: '*', label: 'custom' })
    expect(ok).toBe(false)
    expect(sentMessages).toHaveLength(0)
  })

  test('custom range happy path includes start/end', () => {
    const start = 1715000000000
    const end = 1715600000000
    createRecap({ projectUri: '*', label: 'custom', start, end })
    expect(sentMessages[0].data.period).toEqual({ label: 'custom', start, end })
  })

  test('signals + force flags are forwarded only when set', () => {
    createRecap({ projectUri: '*', label: 'today' })
    expect(sentMessages[0].data.signals).toBeUndefined()
    expect(sentMessages[0].data.force).toBeUndefined()
    sentMessages.length = 0
    createRecap({ projectUri: '*', label: 'today', signals: ['user_prompts', 'commits'], force: true })
    expect(sentMessages[0].data.signals).toEqual(['user_prompts', 'commits'])
    expect(sentMessages[0].data.force).toBe(true)
  })
})

describe('openRecapHistory', () => {
  test('dispatches rclaude-recap-history-open event with projectUri', () => {
    let detail: unknown = null
    const handler = (e: Event) => {
      detail = (e as CustomEvent).detail
    }
    window.addEventListener('rclaude-recap-history-open', handler)
    openRecapHistory('claude://default/p')
    expect(detail).toEqual({ projectUri: 'claude://default/p' })
    window.removeEventListener('rclaude-recap-history-open', handler)
  })

  test('dispatches with no projectUri when omitted', () => {
    let detail: unknown = null
    const handler = (e: Event) => {
      detail = (e as CustomEvent).detail
    }
    window.addEventListener('rclaude-recap-history-open', handler)
    openRecapHistory()
    expect(detail).toEqual({ projectUri: undefined })
    window.removeEventListener('rclaude-recap-history-open', handler)
  })
})
