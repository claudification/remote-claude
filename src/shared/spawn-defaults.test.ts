import { describe, expect, it } from 'bun:test'
import { type DefaultsSource, resolveSpawnConfig } from './spawn-defaults'
import type { SpawnRequest } from './spawn-schema'

const emptyProj: DefaultsSource = {}
const emptyGlobal: DefaultsSource = {}

describe('resolveSpawnConfig', () => {
  describe('model', () => {
    it('uses project default when explicit is missing', () => {
      expect(resolveSpawnConfig({}, { defaultModel: 'sonnet' }, null).model).toBe('sonnet')
    })

    it('explicit wins over project default', () => {
      expect(
        resolveSpawnConfig({ model: 'opus' as SpawnRequest['model'] }, { defaultModel: 'sonnet' }, null).model,
      ).toBe('opus')
    })

    it('project wins over global', () => {
      expect(resolveSpawnConfig({}, { defaultModel: 'sonnet' }, { defaultModel: 'opus' }).model).toBe('sonnet')
    })

    it('falls back to global when project is empty', () => {
      expect(resolveSpawnConfig({}, emptyProj, { defaultModel: 'opus' }).model).toBe('opus')
    })

    it('empty-string default means unset', () => {
      expect(resolveSpawnConfig({}, null, { defaultModel: '' }).model).toBeUndefined()
    })

    it('undefined when nothing set', () => {
      expect(resolveSpawnConfig({}, null, null).model).toBeUndefined()
    })
  })

  describe('effort', () => {
    it("'default' sentinel in project default means unset", () => {
      expect(resolveSpawnConfig({}, { defaultEffort: 'default' }, null).effort).toBeUndefined()
    })

    it('respects real project effort', () => {
      expect(resolveSpawnConfig({}, { defaultEffort: 'high' }, null).effort).toBe('high')
    })

    it("'default' sentinel at global level means unset", () => {
      expect(resolveSpawnConfig({}, null, { defaultEffort: 'default' }).effort).toBeUndefined()
    })
  })

  describe('permissionMode', () => {
    it('adHoc forces bypassPermissions', () => {
      expect(resolveSpawnConfig({ adHoc: true }, null, null).permissionMode).toBe('bypassPermissions')
    })

    it('adHoc overrides explicit permissionMode', () => {
      expect(
        resolveSpawnConfig({ adHoc: true, permissionMode: 'plan' as SpawnRequest['permissionMode'] }, null, null)
          .permissionMode,
      ).toBe('bypassPermissions')
    })

    it('respects explicit permissionMode when not adHoc', () => {
      expect(
        resolveSpawnConfig({ permissionMode: 'acceptEdits' as SpawnRequest['permissionMode'] }, null, null)
          .permissionMode,
      ).toBe('acceptEdits')
    })

    it("'default' sentinel means unset", () => {
      expect(resolveSpawnConfig({}, { defaultPermissionMode: 'default' }, null).permissionMode).toBeUndefined()
    })
  })

  describe('headless', () => {
    it('adHoc always forces headless=true', () => {
      expect(resolveSpawnConfig({ adHoc: true }, null, null).headless).toBe(true)
    })

    it('adHoc overrides global defaultLaunchMode=pty', () => {
      expect(resolveSpawnConfig({ adHoc: true }, null, { defaultLaunchMode: 'pty' }).headless).toBe(true)
    })

    it('explicit headless=false wins when not adHoc', () => {
      expect(resolveSpawnConfig({ headless: false }, null, { defaultLaunchMode: 'headless' }).headless).toBe(false)
    })

    it('project defaultLaunchMode=pty yields headless=false', () => {
      expect(resolveSpawnConfig({}, { defaultLaunchMode: 'pty' }, null).headless).toBe(false)
    })

    it('defaults to headless=true when nothing set', () => {
      expect(resolveSpawnConfig({}, null, null).headless).toBe(true)
    })
  })

  describe('numerics (autocompactPct, maxBudgetUsd)', () => {
    it('zero in project default means unset', () => {
      expect(resolveSpawnConfig({}, { defaultAutocompactPct: 0 }, { defaultAutocompactPct: 80 }).autocompactPct).toBe(
        80,
      )
    })

    it('explicit positive wins', () => {
      expect(resolveSpawnConfig({ autocompactPct: 50 }, { defaultAutocompactPct: 80 }, null).autocompactPct).toBe(50)
    })

    it('maxBudgetUsd falls back across levels', () => {
      expect(resolveSpawnConfig({}, null, { defaultMaxBudgetUsd: 5 }).maxBudgetUsd).toBe(5)
      expect(resolveSpawnConfig({}, null, { defaultMaxBudgetUsd: 0 }).maxBudgetUsd).toBeUndefined()
    })
  })

  describe('booleans (bare, repl)', () => {
    it('explicit false overrides project true', () => {
      expect(resolveSpawnConfig({ bare: false }, { defaultBare: true }, null).bare).toBe(false)
    })

    it('falls back to project', () => {
      expect(resolveSpawnConfig({}, { defaultBare: true }, null).bare).toBe(true)
    })

    it('falls back to global when project is undefined', () => {
      expect(resolveSpawnConfig({}, null, { defaultRepl: true }).repl).toBe(true)
    })
  })

  it('preserves other request fields untouched', () => {
    const partial: Partial<SpawnRequest> = {
      cwd: '/tmp/x',
      mkdir: true,
      prompt: 'hi',
      worktree: 'feat-x',
      adHoc: false,
    }
    const out = resolveSpawnConfig(partial, emptyProj, emptyGlobal)
    expect(out.cwd).toBe('/tmp/x')
    expect(out.mkdir).toBe(true)
    expect(out.prompt).toBe('hi')
    expect(out.worktree).toBe('feat-x')
  })
})
