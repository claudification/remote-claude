/**
 * Polymorphic shares round-trip: confirms that conversation shares and
 * recap shares both serialize through createShare + validateShare with
 * the right targetKind/targetId fields.
 *
 * The Phase 7 routes already exercise the recap-share creation path end-to-end.
 * This test pins the shared module's contract for both kinds.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createShare, initShares, validateShare } from '../shares'
import { createMemoryDriver } from '../store/memory/driver'

let store = createMemoryDriver()

beforeEach(() => {
  store = createMemoryDriver()
  store.init()
  initShares({ kv: store.kv, skipTimers: true })
})

afterEach(() => {
  store.close()
})

describe('polymorphic shares', () => {
  test('conversation share is created with targetKind=conversation', () => {
    const share = createShare({
      project: 'claude://default/p/foo',
      conversationId: 'conv_abcdef123456',
      expiresAt: Date.now() + 3600_000,
      createdBy: 'tester',
      targetKind: 'conversation',
      targetId: 'claude://default/p/foo',
    })
    expect(share.targetKind).toBe('conversation')
    expect(share.targetId).toBe('claude://default/p/foo')
    expect(share.permissions.length).toBeGreaterThan(0)
  })

  test('recap share is created with targetKind=recap and empty permissions', () => {
    const share = createShare({
      project: 'claude://default/p/foo',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      createdBy: 'tester',
      label: 'My Recap',
      permissions: [],
      targetKind: 'recap',
      targetId: 'recap_xyz',
    })
    expect(share.targetKind).toBe('recap')
    expect(share.targetId).toBe('recap_xyz')
    expect(share.permissions).toEqual([])
  })

  test('round-trip: validateShare returns the same targetKind/targetId', () => {
    const created = createShare({
      project: 'claude://default/p',
      expiresAt: Date.now() + 60_000,
      createdBy: 'tester',
      targetKind: 'recap',
      targetId: 'recap_aa',
    })
    const validated = validateShare(created.token)
    expect(validated).not.toBeNull()
    expect(validated?.targetKind).toBe('recap')
    expect(validated?.targetId).toBe('recap_aa')
  })

  test('legacy-shape conversation share (no targetKind) requires conversationId', () => {
    // No targetKind defaults to 'conversation'. Without conversationId the
    // share would grant project-wide access, which is now refused at
    // creation time.
    expect(() =>
      createShare({
        project: 'claude://default/p',
        expiresAt: Date.now() + 60_000,
        createdBy: 'tester',
      }),
    ).toThrow(/conversationId is required/)

    const valid = createShare({
      project: 'claude://default/p',
      conversationId: 'conv_legacyshape',
      expiresAt: Date.now() + 60_000,
      createdBy: 'tester',
    })
    expect(valid.targetKind).toBeUndefined()
    expect(validateShare(valid.token)?.conversationId).toBe('conv_legacyshape')
  })

  test('different recap shares get distinct tokens', () => {
    const a = createShare({
      project: '*',
      expiresAt: Date.now() + 60_000,
      createdBy: 'tester',
      targetKind: 'recap',
      targetId: 'recap_a',
    })
    const b = createShare({
      project: '*',
      expiresAt: Date.now() + 60_000,
      createdBy: 'tester',
      targetKind: 'recap',
      targetId: 'recap_b',
    })
    expect(a.token).not.toBe(b.token)
  })
})
