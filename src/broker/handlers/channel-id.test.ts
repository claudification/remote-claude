import { describe, expect, it } from 'vitest'
import {
  type ConversationLike,
  computeLocalId,
  computeSessionSlug,
  formatAmbiguityError,
  resolveSendTarget,
} from './channel-id'

function s(id: string, title?: string, project = 'claude:///projects/arr'): ConversationLike {
  return { id, title, project }
}

describe('computeSessionSlug', () => {
  it('uses the title when set', () => {
    const a = s('aaaaaaaaaa', 'viral-zebra')
    expect(computeSessionSlug(a, [a])).toBe('viral-zebra')
  })

  it('falls back to a 8-char id slice when no title', () => {
    const a = s('abcdef0123456789')
    expect(computeSessionSlug(a, [a])).toBe('abcdef01')
  })

  it('disambiguates with a 6-char id suffix on collision', () => {
    const a = s('aaaaaa1111', 'rebel')
    const b = s('bbbbbb2222', 'rebel')
    expect(computeSessionSlug(a, [a, b])).toBe('rebel-aaaaaa')
    expect(computeSessionSlug(b, [a, b])).toBe('rebel-bbbbbb')
  })

  it('does not collide with itself in the siblingSessions', () => {
    const a = s('aaaaaaaa', 'solo')
    expect(computeSessionSlug(a, [a])).toBe('solo')
  })
})

describe('computeLocalId', () => {
  it('always produces compound ids -- even for a single-session project', () => {
    // This is the whole point of the always-compound rule: ids must not flip
    // shape when a second session spawns later.
    const a = s('xxxxxxxx', 'viral-zebra')
    expect(computeLocalId(a, 'arr', [a])).toBe('arr:viral-zebra')
  })

  it('appends disambiguated session slug when multiple share the project', () => {
    const a = s('aaaaaa1111', 'rebel')
    const b = s('bbbbbb2222', 'rebel')
    expect(computeLocalId(a, 'arr', [a, b])).toBe('arr:rebel-aaaaaa')
  })
})

// ─── resolveSendTarget ──────────────────────────────────────────────

const allLive = (_: ConversationLike) => true
const noneLive = (_: ConversationLike) => false

describe('resolveSendTarget', () => {
  describe('compound `project:session-slug`', () => {
    it('resolves an exact session-slug match', () => {
      const a = s('a', 'viral-zebra')
      const b = s('b', 'punk-jackal')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        sessionSlug: 'punk-jackal',
        sessionsAtProject: [a, b],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.session.id).toBe('b')
    })

    it('falls back to a prefix match when no exact', () => {
      const a = s('a', 'viral-zebra')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        sessionSlug: 'viral',
        sessionsAtProject: [a],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.session.id).toBe('a')
    })

    it('returns not_found when no session matches', () => {
      const a = s('a', 'viral-zebra')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        sessionSlug: 'nope',
        sessionsAtProject: [a],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('not_found')
    })
  })

  describe('bare `project` -- accepted only when single', () => {
    it('resolves to the lone live session', () => {
      const a = s('a', 'viral-zebra')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        sessionSlug: undefined,
        sessionsAtProject: [a],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.session.id).toBe('a')
    })

    it('FAILS as ambiguous when multiple LIVE sessions share the project', () => {
      const a = s('a', 'viral-zebra')
      const b = s('b', 'punk-jackal')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        sessionSlug: undefined,
        sessionsAtProject: [a, b],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('ambiguous')
      if (r.kind === 'ambiguous') {
        expect(r.candidates).toHaveLength(2)
        expect(r.canonicalProject).toBe('arr')
      }
    })

    it('picks the unique LIVE session when there are dead siblings', () => {
      const live = s('live', 'viral-zebra')
      const dead = s('dead', 'punk-jackal')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        sessionSlug: undefined,
        sessionsAtProject: [live, dead],
        canonicalProject: 'arr',
        isLive: x => x.id === 'live',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.session.id).toBe('live')
    })

    it('FAILS as ambiguous when no live sessions but multiple inactive', () => {
      const a = s('a', 'viral-zebra')
      const b = s('b', 'punk-jackal')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        sessionSlug: undefined,
        sessionsAtProject: [a, b],
        canonicalProject: 'arr',
        isLive: noneLive,
      })
      expect(r.kind).toBe('ambiguous')
    })

    it('falls back to a single inactive session when none are live', () => {
      const a = s('a', 'viral-zebra')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        sessionSlug: undefined,
        sessionsAtProject: [a],
        canonicalProject: 'arr',
        isLive: noneLive,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.session.id).toBe('a')
    })

    it('prefers a session whose own title matches the bare slug', () => {
      // Edge case: if a session is literally named "arr" inside project "arr",
      // bare addressing should target THAT session, not project-level dispatch.
      const namedArr = s('named', 'arr')
      const other = s('other', 'punk-jackal')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        sessionSlug: undefined,
        sessionsAtProject: [namedArr, other],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.session.id).toBe('named')
    })

    it('returns not_found when the project has no sessions at all', () => {
      const r = resolveSendTarget({
        projectSlug: 'arr',
        sessionSlug: undefined,
        sessionsAtProject: [],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('not_found')
    })
  })
})

describe('formatAmbiguityError', () => {
  it('lists compound ids the caller should retry with', () => {
    const a = s('aaaaaa1111', 'viral-zebra')
    const b = s('bbbbbb2222', 'punk-jackal')
    const msg = formatAmbiguityError('arr', [a, b])
    expect(msg).toContain('Ambiguous target: 2 sessions at "arr"')
    expect(msg).toContain('arr:viral-zebra')
    expect(msg).toContain('arr:punk-jackal')
  })

  it('disambiguates colliding session titles in the suggested ids', () => {
    const a = s('aaaaaa1111', 'rebel')
    const b = s('bbbbbb2222', 'rebel')
    const msg = formatAmbiguityError('arr', [a, b])
    expect(msg).toContain('arr:rebel-aaaaaa')
    expect(msg).toContain('arr:rebel-bbbbbb')
  })
})
