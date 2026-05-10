import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createGatewayRegistry, isGatewaySecret, isValidGatewayAlias } from '../gateway-registry'

const TEST_DIR = join(import.meta.dir, '.test-gateway-registry')

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
})

describe('gateway secret format', () => {
  it('identifies gateway secrets by prefix', () => {
    expect(isGatewaySecret('gw_abc123')).toBe(true)
    expect(isGatewaySecret('snt_abc123')).toBe(false)
    expect(isGatewaySecret('random')).toBe(false)
  })
})

describe('gateway alias validation', () => {
  it('accepts valid aliases', () => {
    expect(isValidGatewayAlias('hermes')).toBe(true)
    expect(isValidGatewayAlias('hermes-prod')).toBe(true)
    expect(isValidGatewayAlias('h1')).toBe(true)
  })

  it('rejects invalid aliases', () => {
    expect(isValidGatewayAlias('')).toBe(false)
    expect(isValidGatewayAlias('UPPERCASE')).toBe(false)
    expect(isValidGatewayAlias('-starts-with-dash')).toBe(false)
    expect(isValidGatewayAlias('123starts-with-number')).toBe(false)
  })
})

describe('GatewayRegistry', () => {
  it('creates a gateway with generated secret', () => {
    const registry = createGatewayRegistry(TEST_DIR)
    const record = registry.create({ alias: 'hermes', gatewayType: 'hermes' })

    expect(record.gatewayId).toBeDefined()
    expect(record.alias).toBe('hermes')
    expect(record.gatewayType).toBe('hermes')
    expect(record.rawSecret).toBeDefined()
    expect(isGatewaySecret(record.rawSecret!)).toBe(true)
  })

  it('finds gateway by secret', () => {
    const registry = createGatewayRegistry(TEST_DIR)
    const record = registry.create({ alias: 'hermes', gatewayType: 'hermes' })

    const found = registry.findBySecret(record.rawSecret!)
    expect(found).toBeDefined()
    expect(found!.gatewayId).toBe(record.gatewayId)
    expect(found!.alias).toBe('hermes')
  })

  it('finds gateway by alias', () => {
    const registry = createGatewayRegistry(TEST_DIR)
    const record = registry.create({ alias: 'hermes', gatewayType: 'hermes' })

    const found = registry.findByAlias('hermes')
    expect(found).toBeDefined()
    expect(found!.gatewayId).toBe(record.gatewayId)
  })

  it('returns undefined for unknown alias', () => {
    const registry = createGatewayRegistry(TEST_DIR)
    expect(registry.findByAlias('nonexistent')).toBeUndefined()
  })

  it('removes a gateway and invalidates its secret', () => {
    const registry = createGatewayRegistry(TEST_DIR)
    const record = registry.create({ alias: 'hermes', gatewayType: 'hermes' })

    expect(registry.remove(record.gatewayId)).toBe(true)
    expect(registry.findBySecret(record.rawSecret!)).toBeUndefined()
    expect(registry.findByAlias('hermes')).toBeUndefined()
  })

  it('persists across instances', () => {
    const r1 = createGatewayRegistry(TEST_DIR)
    const record = r1.create({ alias: 'hermes', gatewayType: 'hermes' })

    const r2 = createGatewayRegistry(TEST_DIR)
    const found = r2.findBySecret(record.rawSecret!)
    expect(found).toBeDefined()
    expect(found!.alias).toBe('hermes')
  })

  it('lists all gateways', () => {
    const registry = createGatewayRegistry(TEST_DIR)
    registry.create({ alias: 'hermes', gatewayType: 'hermes' })
    registry.create({ alias: 'custom', gatewayType: 'custom' })

    const all = registry.getAll()
    expect(all.size).toBe(2)
  })
})
