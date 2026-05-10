import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SentinelRegistry } from '../sentinel-registry'
import { createSentinelRegistry } from '../sentinel-registry'

const TEST_CACHE_DIR = join(import.meta.dirname, '.test-sentinel-registry')

let registry: SentinelRegistry

beforeEach(() => {
  mkdirSync(TEST_CACHE_DIR, { recursive: true })
  registry = createSentinelRegistry(TEST_CACHE_DIR)
})

afterEach(() => {
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
})

describe('sentinel-registry', () => {
  it('starts empty with no sentinels', () => {
    expect(registry.getAll().size).toBe(0)
    expect(registry.getDefaultId()).toBeUndefined()
    expect(registry.getDefault()).toBeUndefined()
  })

  it('create() returns a record with a generated sentinelId', () => {
    const record = registry.create({ alias: 'studio' })
    expect(record.sentinelId).toBeDefined()
    expect(record.aliases).toEqual(['studio'])
    expect(record.isDefault).toBe(true)
    expect(record.createdAt).toBeGreaterThan(0)
  })

  it('create() supports multiple aliases', () => {
    const record = registry.create({ aliases: ['default', 'studio', 'jonas-mbp'] })
    expect(record.aliases).toEqual(['default', 'studio', 'jonas-mbp'])
  })

  it('first sentinel is always default', () => {
    const first = registry.create({ alias: 'first' })
    expect(first.isDefault).toBe(true)
    expect(registry.getDefaultId()).toBe(first.sentinelId)
  })

  it('second sentinel is not default unless specified', () => {
    registry.create({ alias: 'first' })
    const second = registry.create({ alias: 'second' })
    expect(second.isDefault).toBe(false)
    expect(registry.getDefaultId()).not.toBe(second.sentinelId)
  })

  it('second sentinel can be made default via isDefault flag', () => {
    const first = registry.create({ alias: 'first' })
    const second = registry.create({ alias: 'second', isDefault: true })
    expect(second.isDefault).toBe(true)
    expect(registry.getDefaultId()).toBe(second.sentinelId)
    const firstRecord = registry.get(first.sentinelId)
    expect(firstRecord?.isDefault).toBe(false)
  })

  it('get() returns the record by sentinelId', () => {
    const created = registry.create({ alias: 'test', color: '#ff0000' })
    const fetched = registry.get(created.sentinelId)
    expect(fetched).toBeDefined()
    expect(fetched?.aliases).toEqual(['test'])
    expect(fetched?.color).toBe('#ff0000')
  })

  it('get() returns undefined for unknown sentinelId', () => {
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('findByAlias() matches any alias in the aliases array', () => {
    registry.create({ aliases: ['default', 'beast', 'server01'] })
    expect(registry.findByAlias('default')).toBeDefined()
    expect(registry.findByAlias('beast')).toBeDefined()
    expect(registry.findByAlias('server01')).toBeDefined()
    expect(registry.findByAlias('nope')).toBeUndefined()
  })

  it('findBySecret() returns the matching record', () => {
    const created = registry.create({ alias: 'test', secret: 'snt_test123' })
    const found = registry.findBySecret('snt_test123')
    expect(found).toBeDefined()
    expect(found?.sentinelId).toBe(created.sentinelId)
  })

  it('findBySecret() returns undefined for unknown secret', () => {
    expect(registry.findBySecret('nope')).toBeUndefined()
  })

  it('findBySecret() returns undefined for sentinels without secrets', () => {
    registry.create({ alias: 'nosecret' })
    expect(registry.findBySecret('')).toBeUndefined()
  })

  it('setDefault() changes the default sentinel', () => {
    const first = registry.create({ alias: 'first' })
    const second = registry.create({ alias: 'second' })
    expect(registry.getDefaultId()).toBe(first.sentinelId)
    const ok = registry.setDefault(second.sentinelId)
    expect(ok).toBe(true)
    expect(registry.getDefaultId()).toBe(second.sentinelId)
    expect(registry.get(first.sentinelId)?.isDefault).toBe(false)
    expect(registry.get(second.sentinelId)?.isDefault).toBe(true)
  })

  it('setDefault() returns false for unknown sentinelId', () => {
    expect(registry.setDefault('nonexistent')).toBe(false)
  })

  it('remove() deletes the sentinel', () => {
    const created = registry.create({ alias: 'temp' })
    expect(registry.getAll().size).toBe(1)
    const ok = registry.remove(created.sentinelId)
    expect(ok).toBe(true)
    expect(registry.getAll().size).toBe(0)
    expect(registry.get(created.sentinelId)).toBeUndefined()
  })

  it('remove() clears secret index', () => {
    const created = registry.create({ alias: 'temp', secret: 'snt_remove' })
    registry.remove(created.sentinelId)
    expect(registry.findBySecret('snt_remove')).toBeUndefined()
  })

  it('remove() promotes next sentinel to default when removing default', () => {
    const first = registry.create({ alias: 'first' })
    const second = registry.create({ alias: 'second' })
    expect(registry.getDefaultId()).toBe(first.sentinelId)
    registry.remove(first.sentinelId)
    expect(registry.getDefaultId()).toBe(second.sentinelId)
    expect(registry.get(second.sentinelId)?.isDefault).toBe(true)
  })

  it('remove() returns false for unknown sentinelId', () => {
    expect(registry.remove('nonexistent')).toBe(false)
  })

  it('getAll() returns all sentinels', () => {
    registry.create({ alias: 'a' })
    registry.create({ alias: 'b' })
    registry.create({ alias: 'c' })
    expect(registry.getAll().size).toBe(3)
  })

  it('persists to disk and reloads', () => {
    const created = registry.create({ alias: 'persistent', color: '#00ff00' })

    const reloaded = createSentinelRegistry(TEST_CACHE_DIR)
    const fetched = reloaded.get(created.sentinelId)
    expect(fetched).toBeDefined()
    expect(fetched?.aliases).toEqual(['persistent'])
    expect(fetched?.color).toBe('#00ff00')
    expect(reloaded.getDefaultId()).toBe(created.sentinelId)
  })

  it('persists secret index across reloads', () => {
    registry.create({ alias: 'secret-test', secret: 'snt_persist' })

    const reloaded = createSentinelRegistry(TEST_CACHE_DIR)
    const found = reloaded.findBySecret('snt_persist')
    expect(found).toBeDefined()
    expect(found?.aliases).toEqual(['secret-test'])
  })

  it('getDefault() returns the default sentinel with id', () => {
    const created = registry.create({ alias: 'def' })
    const def = registry.getDefault()
    expect(def).toBeDefined()
    expect(def?.sentinelId).toBe(created.sentinelId)
    expect(def?.aliases).toEqual(['def'])
  })

  it('handles corrupted settings file gracefully', () => {
    const filePath = join(TEST_CACHE_DIR, 'sentinel-registry.json')
    writeFileSync(filePath, 'not json at all')

    const recovered = createSentinelRegistry(TEST_CACHE_DIR)
    expect(recovered.getAll().size).toBe(0)
    expect(recovered.getDefaultId()).toBeUndefined()
  })
})
