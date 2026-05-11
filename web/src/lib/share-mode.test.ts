/**
 * Share-mode detection tests.
 *
 * Note: share-mode.ts captures window state at module-load time. Each test
 * uses vi.resetModules() + history.replaceState() to reload with a fresh
 * URL.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const ORIGINAL_HASH = window.location.hash
const ORIGINAL_SEARCH = window.location.search

afterEach(() => {
  history.replaceState({}, '', `${window.location.pathname}${ORIGINAL_SEARCH}${ORIGINAL_HASH}`)
})

beforeEach(() => {
  vi.resetModules()
})

async function loadFresh() {
  return import('./share-mode')
}

describe('share-mode detection', () => {
  test('no share token -> null', async () => {
    history.replaceState({}, '', '/')
    const m = await loadFresh()
    expect(m.detectShareMode()).toBeNull()
    expect(m.detectShareKind()).toBe('conversation')
  })

  test('hash form /#/share/TOKEN -> conversation kind', async () => {
    history.replaceState({}, '', '/#/share/legacytok123')
    const m = await loadFresh()
    expect(m.detectShareMode()).toBe('legacytok123')
    expect(m.detectShareKind()).toBe('conversation')
  })

  test('query form ?share=TOKEN -> conversation kind by default', async () => {
    history.replaceState({}, '', '/?share=querytok456')
    const m = await loadFresh()
    expect(m.detectShareMode()).toBe('querytok456')
    expect(m.detectShareKind()).toBe('conversation')
  })

  test('query form ?share=TOKEN&kind=recap -> recap kind', async () => {
    history.replaceState({}, '', '/?share=recaptok789&kind=recap')
    const m = await loadFresh()
    expect(m.detectShareMode()).toBe('recaptok789')
    expect(m.detectShareKind()).toBe('recap')
  })

  test('hash form takes precedence over query form when both present', async () => {
    history.replaceState({}, '', '/?share=querywins&kind=recap#/share/hashwins')
    const m = await loadFresh()
    expect(m.detectShareMode()).toBe('hashwins')
    expect(m.detectShareKind()).toBe('conversation')
  })

  test('clearShareMode resets both token and kind', async () => {
    history.replaceState({}, '', '/?share=tok&kind=recap')
    const m = await loadFresh()
    expect(m.detectShareMode()).toBe('tok')
    m.clearShareMode()
    expect(m.detectShareMode()).toBeNull()
    expect(m.detectShareKind()).toBe('conversation')
  })

  test('appendShareParam attaches token + uses ? or & correctly', async () => {
    history.replaceState({}, '', '/?share=appendtok')
    const m = await loadFresh()
    expect(m.appendShareParam('/api/foo')).toBe('/api/foo?share=appendtok')
    expect(m.appendShareParam('/api/foo?x=1')).toBe('/api/foo?x=1&share=appendtok')
  })

  test('buildWsUrl includes ?share=TOKEN', async () => {
    history.replaceState({}, '', '/?share=wsstok')
    const m = await loadFresh()
    expect(m.buildWsUrl()).toContain('share=wsstok')
  })
})
