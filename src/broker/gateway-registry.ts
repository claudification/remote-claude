/**
 * Gateway Registry -- persisted registry of gateway adapters.
 *
 * Manages gateway records in `{cacheDir}/gateway-registry.json`.
 * Each gateway gets a unique secret (gw_ prefix) for authentication,
 * scoped to gateway operations only (no admin/sentinel access).
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GATEWAY_SECRET_PREFIX = 'gw_'

function generateGatewaySecret(): string {
  return GATEWAY_SECRET_PREFIX + randomBytes(32).toString('base64url')
}

export function isGatewaySecret(secret: string): boolean {
  return secret.startsWith(GATEWAY_SECRET_PREFIX)
}

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,62}$/

export function isValidGatewayAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias)
}

export interface GatewayRecord {
  alias: string
  gatewayType: string // e.g. 'hermes', 'custom'
  secret?: string
  createdAt: number
  label?: string
}

export type GatewayRecordWithId = GatewayRecord & { gatewayId: string }

interface GatewayRegistryData {
  gateways: Record<string, GatewayRecord>
}

export interface GatewayRegistry {
  load(): void
  save(): void
  create(opts: {
    alias: string
    gatewayType: string
    label?: string
    generateSecret?: boolean
  }): GatewayRecordWithId & { rawSecret?: string }
  get(gatewayId: string): GatewayRecord | undefined
  findBySecret(secret: string): GatewayRecordWithId | undefined
  findByAlias(alias: string): GatewayRecordWithId | undefined
  remove(gatewayId: string): boolean
  getAll(): Map<string, GatewayRecord>
}

export function createGatewayRegistry(cacheDir: string): GatewayRegistry {
  const filePath = join(cacheDir, 'gateway-registry.json')
  let data: GatewayRegistryData = { gateways: {} }
  const secretIndex = new Map<string, string>() // secret -> gatewayId

  function rebuildSecretIndex(): void {
    secretIndex.clear()
    for (const [id, record] of Object.entries(data.gateways)) {
      if (record.secret) secretIndex.set(record.secret, id)
    }
  }

  function load(): void {
    try {
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf8')
        const parsed = JSON.parse(raw) as GatewayRegistryData
        data = { gateways: parsed.gateways || {} }
        rebuildSecretIndex()
      }
    } catch {
      data = { gateways: {} }
      secretIndex.clear()
    }
  }

  function save(): void {
    try {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(filePath, JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(`[gateway-registry] Failed to save: ${err}`)
    }
  }

  function create(opts: {
    alias: string
    gatewayType: string
    label?: string
    generateSecret?: boolean
  }): GatewayRecordWithId & { rawSecret?: string } {
    const gatewayId = randomUUID()
    const record: GatewayRecord = {
      alias: opts.alias,
      gatewayType: opts.gatewayType,
      label: opts.label,
      createdAt: Date.now(),
    }
    let rawSecret: string | undefined
    if (opts.generateSecret !== false) {
      rawSecret = generateGatewaySecret()
      record.secret = rawSecret
      secretIndex.set(rawSecret, gatewayId)
    }
    data.gateways[gatewayId] = record
    save()
    return { gatewayId, ...record, rawSecret }
  }

  function get(gatewayId: string): GatewayRecord | undefined {
    return data.gateways[gatewayId]
  }

  function findBySecret(secret: string): GatewayRecordWithId | undefined {
    const gatewayId = secretIndex.get(secret)
    if (!gatewayId) return undefined
    const record = data.gateways[gatewayId]
    if (!record) return undefined
    return { gatewayId, ...record }
  }

  function findByAlias(alias: string): GatewayRecordWithId | undefined {
    for (const [gatewayId, record] of Object.entries(data.gateways)) {
      if (record.alias === alias) return { gatewayId, ...record }
    }
    return undefined
  }

  function remove(gatewayId: string): boolean {
    const record = data.gateways[gatewayId]
    if (!record) return false
    if (record.secret) secretIndex.delete(record.secret)
    delete data.gateways[gatewayId]
    save()
    return true
  }

  function getAll(): Map<string, GatewayRecord> {
    return new Map(Object.entries(data.gateways))
  }

  load()

  return { load, save, create, get, findBySecret, findByAlias, remove, getAll }
}
