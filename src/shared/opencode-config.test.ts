import { describe, expect, it } from 'bun:test'
import {
  buildOpenCodeConfig,
  DEFAULT_OPENCODE_TOOL_PERMISSION,
  normalizeTier,
  OPENCODE_ALL_TOOLS,
  OPENCODE_SAFE_TOOLS,
  shouldSkipPermissions,
} from './opencode-config'

describe('buildOpenCodeConfig', () => {
  it('returns null for the full tier (caller passes --dangerously-skip-permissions)', () => {
    expect(buildOpenCodeConfig('full')).toBeNull()
  })

  it('disables every known tool for the none tier', () => {
    const cfg = buildOpenCodeConfig('none')
    expect(cfg).not.toBeNull()
    if (!cfg) return
    expect(cfg.tools).toBeDefined()
    for (const t of OPENCODE_ALL_TOOLS) {
      expect(cfg.tools?.[t]).toBe(false)
      expect(cfg.permission?.[t]).toBe('deny')
    }
  })

  it('enables only the safe tools for the safe tier and denies the rest', () => {
    const cfg = buildOpenCodeConfig('safe')
    expect(cfg).not.toBeNull()
    if (!cfg) return
    const safeSet = new Set<string>(OPENCODE_SAFE_TOOLS)
    for (const t of OPENCODE_ALL_TOOLS) {
      if (safeSet.has(t)) {
        expect(cfg.tools?.[t]).toBe(true)
        expect(cfg.permission?.[t]).toBe('allow')
      } else {
        expect(cfg.tools?.[t]).toBe(false)
        expect(cfg.permission?.[t]).toBe('deny')
      }
    }
  })

  it('safe tier explicitly disables bash, write, and edit', () => {
    const cfg = buildOpenCodeConfig('safe')
    expect(cfg?.tools?.bash).toBe(false)
    expect(cfg?.tools?.write).toBe(false)
    expect(cfg?.tools?.edit).toBe(false)
    expect(cfg?.permission?.bash).toBe('deny')
    expect(cfg?.permission?.write).toBe('deny')
    expect(cfg?.permission?.edit).toBe('deny')
  })

  it('emits the official $schema field so editor tooling validates it', () => {
    expect(buildOpenCodeConfig('safe')?.$schema).toBe('https://opencode.ai/config.json')
    expect(buildOpenCodeConfig('none')?.$schema).toBe('https://opencode.ai/config.json')
  })
})

describe('shouldSkipPermissions', () => {
  it('is true only for the full tier', () => {
    expect(shouldSkipPermissions('full')).toBe(true)
    expect(shouldSkipPermissions('safe')).toBe(false)
    expect(shouldSkipPermissions('none')).toBe(false)
  })
})

describe('normalizeTier', () => {
  it('passes through valid tiers', () => {
    expect(normalizeTier('none')).toBe('none')
    expect(normalizeTier('safe')).toBe('safe')
    expect(normalizeTier('full')).toBe('full')
  })

  it('falls back to the default for invalid inputs', () => {
    expect(normalizeTier(undefined)).toBe(DEFAULT_OPENCODE_TOOL_PERMISSION)
    expect(normalizeTier(null)).toBe(DEFAULT_OPENCODE_TOOL_PERMISSION)
    expect(normalizeTier('')).toBe(DEFAULT_OPENCODE_TOOL_PERMISSION)
    expect(normalizeTier('bogus')).toBe(DEFAULT_OPENCODE_TOOL_PERMISSION)
    expect(normalizeTier(42)).toBe(DEFAULT_OPENCODE_TOOL_PERMISSION)
  })

  it('default tier is safe (least privilege)', () => {
    expect(DEFAULT_OPENCODE_TOOL_PERMISSION).toBe('safe')
  })
})
