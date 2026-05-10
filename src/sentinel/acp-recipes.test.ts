import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { getAcpRecipe, listAcpRecipes, OPENCODE_RECIPE } from './acp-recipes'

describe('getAcpRecipe', () => {
  it('returns the opencode recipe by name', () => {
    expect(getAcpRecipe('opencode')).toBe(OPENCODE_RECIPE)
  })
  it('returns null for unknown names', () => {
    expect(getAcpRecipe('codex')).toBeNull()
    expect(getAcpRecipe('')).toBeNull()
  })
})

describe('listAcpRecipes', () => {
  it('includes the opencode recipe', () => {
    const all = listAcpRecipes()
    expect(all.map(r => r.name)).toContain('opencode')
  })
})

describe('OPENCODE_RECIPE.prepare', () => {
  it('writes an opencode.json with permission: ask for tier safe and preserves user config', () => {
    const out = OPENCODE_RECIPE.prepare?.({
      conversationId: 'test-' + Math.random().toString(36).slice(2),
      cwd: '/tmp',
      toolPermission: 'safe',
    })
    expect(out).toBeDefined()
    expect(out!.env.OPENCODE_CONFIG).toMatch(/opencode\.json$/)
    // We DON'T disable project config -- the user's project-level opencode.json
    // can still apply on top, consistent with OpenCode's normal layering.
    expect(out!.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
    const cfgText = readFileSync(out!.env.OPENCODE_CONFIG, 'utf8')
    const cfg = JSON.parse(cfgText)
    expect(cfg.permission.bash).toBe('ask')
    expect(cfg.permission.edit).toBe('ask')
    expect(cfg.permission.write).toBe('ask')
    expect(cfg.$schema).toBe('https://opencode.ai/config.json')
    out!.cleanup?.()
    expect(existsSync(out!.env.OPENCODE_CONFIG)).toBe(false)
  })

  it('also writes the config for tier none (host rejects all requests)', () => {
    const out = OPENCODE_RECIPE.prepare?.({
      conversationId: 'test-' + Math.random().toString(36).slice(2),
      cwd: '/tmp',
      toolPermission: 'none',
    })
    expect(out!.env.OPENCODE_CONFIG).toBeTruthy()
    out!.cleanup?.()
  })

  it('writes no config for tier full (no permission prompts wanted)', () => {
    const out = OPENCODE_RECIPE.prepare?.({
      conversationId: 'test-full',
      cwd: '/tmp',
      toolPermission: 'full',
    })
    expect(out).toEqual({ env: {} })
  })
})
