// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _test } from './key-layers'

const { pushLayer, popLayer, dispatch, normalizeEvent, layers, resetDoubleTap } = _test

function key(
  key: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
}

function clear() {
  while (layers.length > 0) popLayer(layers[0])
  resetDoubleTap()
}

describe('key-layers', () => {
  beforeEach(clear)
  afterEach(clear)

  describe('normalizeEvent', () => {
    it('normalizes bare Escape', () => {
      expect(normalizeEvent(key('Escape'))).toBe('Escape')
    })

    it('normalizes Ctrl+K as mod+k (jsdom is non-Mac)', () => {
      expect(normalizeEvent(key('k', { ctrlKey: true }))).toBe('mod+k')
    })

    it('ignores Meta key on non-Mac (Windows/Super key not used for shortcuts)', () => {
      // On non-Mac (jsdom), metaKey is the Windows key -- not mapped to anything
      expect(normalizeEvent(key('k', { metaKey: true }))).toBe('k')
    })

    it('normalizes shift+letter to lowercase', () => {
      expect(normalizeEvent(key('D', { shiftKey: true }))).toBe('shift+d')
    })

    it('ignores bare modifier presses', () => {
      expect(normalizeEvent(key('Control'))).toBe('')
      expect(normalizeEvent(key('Shift'))).toBe('')
      expect(normalizeEvent(key('Meta'))).toBe('')
      expect(normalizeEvent(key('Alt'))).toBe('')
    })

    it('normalizes Enter', () => {
      expect(normalizeEvent(key('Enter'))).toBe('Enter')
    })

    it('normalizes arrow keys', () => {
      expect(normalizeEvent(key('ArrowDown'))).toBe('ArrowDown')
      expect(normalizeEvent(key('ArrowUp'))).toBe('ArrowUp')
    })
  })

  describe('layer stack', () => {
    it('pushes and pops layers', () => {
      const l1 = pushLayer({ Escape: vi.fn() }, { id: 'a' })
      const l2 = pushLayer({ Enter: vi.fn() }, { id: 'b' })

      expect(layers).toHaveLength(2)
      expect(layers[0].id).toBe('a')
      expect(layers[1].id).toBe('b')

      popLayer(l2)
      expect(layers).toHaveLength(1)
      expect(layers[0].id).toBe('a')

      popLayer(l1)
      expect(layers).toHaveLength(0)
    })

    it('base layers go at the bottom', () => {
      const base = pushLayer({}, { id: 'base', base: true })
      const modal = pushLayer({}, { id: 'modal' })
      const base2 = pushLayer({}, { id: 'base2', base: true })

      expect(layers.map(l => l.id)).toEqual(['base', 'base2', 'modal'])

      popLayer(base)
      popLayer(base2)
      popLayer(modal)
    })
  })

  describe('dispatch', () => {
    it('routes Escape to top layer', () => {
      const base = vi.fn()
      const modal = vi.fn()

      pushLayer({ Escape: base }, { id: 'base', base: true })
      pushLayer({ Escape: modal }, { id: 'modal' })

      dispatch(key('Escape'))

      expect(modal).toHaveBeenCalledOnce()
      expect(base).not.toHaveBeenCalled()
    })

    it('modifier shortcuts pass through non-base layers that dont handle them', () => {
      const handler = vi.fn()
      pushLayer({ 'mod+k': handler }, { id: 'base', base: true })
      pushLayer({ Escape: vi.fn() }, { id: 'modal' })

      // mod+k should reach base even though modal is on top
      // jsdom is non-Mac, so ctrlKey maps to mod
      dispatch(key('k', { ctrlKey: true }))

      expect(handler).toHaveBeenCalledOnce()
    })

    it('non-modifier keys are blocked by top non-base layer even without handler', () => {
      const base = vi.fn()
      pushLayer({ Enter: base }, { id: 'base', base: true })
      pushLayer({ Escape: vi.fn() }, { id: 'modal' }) // modal has no Enter handler

      dispatch(key('Enter'))

      // Enter should NOT reach base -- modal blocks all non-modifier keys
      expect(base).not.toHaveBeenCalled()
    })

    it('disabled layers are skipped', () => {
      const base = vi.fn()
      const modal = vi.fn()

      pushLayer({ Escape: base }, { id: 'base', base: true })
      const layer = pushLayer({ Escape: modal }, { id: 'modal', enabled: false })

      dispatch(key('Escape'))

      // Modal is disabled, so Escape falls through to base
      expect(modal).not.toHaveBeenCalled()
      expect(base).toHaveBeenCalledOnce()

      popLayer(layer)
    })

    it('falls through when no layer handles the key', () => {
      pushLayer({ 'mod+k': vi.fn() }, { id: 'base', base: true })

      // Tab is not handled by any layer -- should not throw
      dispatch(key('Tab'))
    })
  })

  describe('double-tap', () => {
    it('fires double-tap handler on two presses within threshold', () => {
      const single = vi.fn()
      const double = vi.fn()

      pushLayer({ Escape: single, 'Escape Escape': double }, { id: 'base', base: true })

      dispatch(key('Escape'))
      expect(single).toHaveBeenCalledOnce()

      // Second press within threshold
      dispatch(key('Escape'))
      expect(double).toHaveBeenCalledOnce()
      // Single should not fire again
      expect(single).toHaveBeenCalledOnce()
    })

    it('does not fire double-tap if too slow', () => {
      const single = vi.fn()
      const double = vi.fn()

      pushLayer({ Escape: single, 'Escape Escape': double }, { id: 'base', base: true })

      dispatch(key('Escape'))
      expect(single).toHaveBeenCalledOnce()

      // Fake passage of time
      resetDoubleTap()

      dispatch(key('Escape'))
      // Should fire single again, not double
      expect(single).toHaveBeenCalledTimes(2)
      expect(double).not.toHaveBeenCalled()
    })

    it('resets after double-tap fires (no triple-tap)', () => {
      const double = vi.fn()
      pushLayer({ 'Escape Escape': double }, { id: 'base', base: true })

      dispatch(key('Escape'))
      dispatch(key('Escape'))
      expect(double).toHaveBeenCalledOnce()

      // Third press should not re-trigger
      dispatch(key('Escape'))
      expect(double).toHaveBeenCalledOnce()
    })
  })

  describe('layer priority with modals', () => {
    it('modal ESC takes priority over base ESC but base mod+k still works', () => {
      const baseEsc = vi.fn()
      const baseCmdK = vi.fn()
      const modalEsc = vi.fn()

      pushLayer({ Escape: baseEsc, 'mod+k': baseCmdK }, { id: 'base', base: true })
      pushLayer({ Escape: modalEsc }, { id: 'modal' })

      dispatch(key('Escape'))
      expect(modalEsc).toHaveBeenCalledOnce()
      expect(baseEsc).not.toHaveBeenCalled()

      // jsdom is non-Mac, so ctrlKey maps to mod
      dispatch(key('k', { ctrlKey: true }))
      expect(baseCmdK).toHaveBeenCalledOnce()
    })

    it('stacked modals: innermost wins', () => {
      const modal1 = vi.fn()
      const modal2 = vi.fn()

      pushLayer({ Escape: vi.fn() }, { id: 'base', base: true })
      pushLayer({ Escape: modal1 }, { id: 'modal1' })
      const l2 = pushLayer({ Escape: modal2 }, { id: 'modal2' })

      dispatch(key('Escape'))
      expect(modal2).toHaveBeenCalledOnce()
      expect(modal1).not.toHaveBeenCalled()

      // Pop modal2, now modal1 should get it
      popLayer(l2)
      dispatch(key('Escape'))
      expect(modal1).toHaveBeenCalledOnce()
    })
  })
})
