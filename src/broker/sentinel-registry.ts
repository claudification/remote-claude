/**
 * Sentinel Registry -- persisted registry of sentinel hosts.
 *
 * Manages sentinel records in `{cacheDir}/sentinel-registry.json`.
 * Phase 0: single auto-registered sentinel. Phase 1+: per-sentinel secrets + multi-sentinel.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SENTINEL_SECRET_PREFIX = 'snt_'

export function generateSentinelSecret(): string {
  return SENTINEL_SECRET_PREFIX + randomBytes(32).toString('base64url')
}

export function isSentinelSecret(secret: string): boolean {
  return secret.startsWith(SENTINEL_SECRET_PREFIX)
}

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,62}$/

export function isValidSentinelAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias)
}

export interface SentinelRecord {
  aliases: string[] // first is the display alias; findByAlias matches any
  secret?: string // per-sentinel secret (Phase 1+; omitted in Phase 0 auto-registration)
  isDefault: boolean
  color?: string
  createdAt: number
}

export type SentinelRecordWithId = SentinelRecord & { sentinelId: string }

interface SentinelRegistryData {
  sentinels: Record<string, SentinelRecord>
  defaultSentinelId?: string
}

export interface SentinelRegistry {
  load(): void
  save(): void
  create(opts: {
    alias?: string
    aliases?: string[]
    isDefault?: boolean
    color?: string
    secret?: string
    generateSecret?: boolean
  }): SentinelRecordWithId & { rawSecret?: string }
  update(
    sentinelId: string,
    opts: { alias?: string; color?: string; isDefault?: boolean },
  ): SentinelRecordWithId | undefined
  get(sentinelId: string): SentinelRecord | undefined
  findBySecret(secret: string): SentinelRecordWithId | undefined
  findByAlias(alias: string): SentinelRecordWithId | undefined
  getDefaultId(): string | undefined
  getDefault(): SentinelRecordWithId | undefined
  setDefault(sentinelId: string): boolean
  remove(sentinelId: string): boolean
  getAll(): Map<string, SentinelRecord>
}

export function createSentinelRegistry(cacheDir: string): SentinelRegistry {
  const filePath = join(cacheDir, 'sentinel-registry.json')
  let data: SentinelRegistryData = { sentinels: {}, defaultSentinelId: undefined }
  const secretIndex = new Map<string, string>() // secret -> sentinelId

  function rebuildSecretIndex(): void {
    secretIndex.clear()
    for (const [id, record] of Object.entries(data.sentinels)) {
      if (record.secret) secretIndex.set(record.secret, id)
    }
  }

  function load(): void {
    try {
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf8')
        const parsed = JSON.parse(raw) as SentinelRegistryData
        data = {
          sentinels: parsed.sentinels || {},
          defaultSentinelId: parsed.defaultSentinelId,
        }
        for (const record of Object.values(data.sentinels)) {
          if (!record.aliases) {
            const legacy = (record as unknown as { alias?: string }).alias
            record.aliases = legacy ? [legacy] : ['default']
          }
        }
        rebuildSecretIndex()
      }
    } catch {
      data = { sentinels: {}, defaultSentinelId: undefined }
      secretIndex.clear()
    }
  }

  function save(): void {
    try {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(filePath, JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(`[sentinel-registry] Failed to save: ${err}`)
    }
  }

  function create(opts: {
    alias?: string
    aliases?: string[]
    isDefault?: boolean
    color?: string
    secret?: string
    generateSecret?: boolean
  }): SentinelRecordWithId & { rawSecret?: string } {
    const sentinelId = randomUUID()
    const aliases = opts.aliases || (opts.alias ? [opts.alias] : ['default'])
    const isDefault = opts.isDefault ?? Object.keys(data.sentinels).length === 0
    const record: SentinelRecord = {
      aliases,
      isDefault,
      color: opts.color,
      createdAt: Date.now(),
    }
    let rawSecret: string | undefined
    if (opts.generateSecret) {
      rawSecret = generateSentinelSecret()
      record.secret = rawSecret
      secretIndex.set(rawSecret, sentinelId)
    } else if (opts.secret) {
      record.secret = opts.secret
      secretIndex.set(opts.secret, sentinelId)
    }
    data.sentinels[sentinelId] = record
    if (isDefault) {
      for (const [id, r] of Object.entries(data.sentinels)) {
        if (id !== sentinelId) r.isDefault = false
      }
      data.defaultSentinelId = sentinelId
    }
    save()
    return { sentinelId, ...record, rawSecret }
  }

  function update(
    sentinelId: string,
    opts: { alias?: string; color?: string; isDefault?: boolean },
  ): SentinelRecordWithId | undefined {
    const record = data.sentinels[sentinelId]
    if (!record) return undefined
    if (opts.alias !== undefined) {
      record.aliases = [opts.alias, ...record.aliases.filter(a => a !== opts.alias)]
    }
    if (opts.color !== undefined) record.color = opts.color
    if (opts.isDefault === true) {
      for (const [id, r] of Object.entries(data.sentinels)) {
        r.isDefault = id === sentinelId
      }
      data.defaultSentinelId = sentinelId
    }
    save()
    return { sentinelId, ...record }
  }

  function get(sentinelId: string): SentinelRecord | undefined {
    return data.sentinels[sentinelId]
  }

  function findBySecret(secret: string): SentinelRecordWithId | undefined {
    const sentinelId = secretIndex.get(secret)
    if (!sentinelId) return undefined
    const record = data.sentinels[sentinelId]
    if (!record) return undefined
    return { sentinelId, ...record }
  }

  function findByAlias(alias: string): SentinelRecordWithId | undefined {
    for (const [sentinelId, record] of Object.entries(data.sentinels)) {
      if (record.aliases.includes(alias)) return { sentinelId, ...record }
    }
    return undefined
  }

  function getDefaultId(): string | undefined {
    return data.defaultSentinelId
  }

  function getDefault(): SentinelRecordWithId | undefined {
    const id = data.defaultSentinelId
    if (!id) return undefined
    const record = data.sentinels[id]
    if (!record) return undefined
    return { sentinelId: id, ...record }
  }

  function setDefault(sentinelId: string): boolean {
    if (!data.sentinels[sentinelId]) return false
    for (const r of Object.values(data.sentinels)) r.isDefault = false
    data.sentinels[sentinelId].isDefault = true
    data.defaultSentinelId = sentinelId
    save()
    return true
  }

  function remove(sentinelId: string): boolean {
    const record = data.sentinels[sentinelId]
    if (!record) return false
    if (record.secret) secretIndex.delete(record.secret)
    delete data.sentinels[sentinelId]
    if (data.defaultSentinelId === sentinelId) {
      const remaining = Object.keys(data.sentinels)
      data.defaultSentinelId = remaining[0]
      if (data.defaultSentinelId && data.sentinels[data.defaultSentinelId]) {
        data.sentinels[data.defaultSentinelId].isDefault = true
      }
    }
    save()
    return true
  }

  function getAll(): Map<string, SentinelRecord> {
    return new Map(Object.entries(data.sentinels))
  }

  load()

  return {
    load,
    save,
    create,
    update,
    get,
    findBySecret,
    findByAlias,
    getDefaultId,
    getDefault,
    setDefault,
    remove,
    getAll,
  }
}
