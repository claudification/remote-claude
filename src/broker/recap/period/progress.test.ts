import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteDriver } from '../../store/sqlite/driver'
import type { StoreDriver } from '../../store/types'
import { createProgressEmitter, type ProgressMessage } from './progress'
import { createPeriodRecapStore, type PeriodRecapStore } from './store'

describe('ProgressEmitter', () => {
  let cacheDir: string
  let driver: StoreDriver
  let store: PeriodRecapStore
  let messages: ProgressMessage[]

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'recap-progress-test-'))
    driver = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    driver.init()
    store = createPeriodRecapStore(cacheDir)
    store.insert({
      id: 'recap_p1',
      projectUri: 'claude://default/test',
      periodLabel: 'last_7',
      periodStart: 0,
      periodEnd: 1_000,
      timeZone: 'UTC',
      audience: 'human',
      signalsJson: '[]',
      signalsHash: 'h',
      createdAt: Date.now(),
    })
    messages = []
  })

  afterEach(() => {
    driver.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  function build() {
    return createProgressEmitter({
      recapId: 'recap_p1',
      store,
      broadcaster: { broadcast: msg => messages.push(msg as ProgressMessage) },
    })
  }

  it('emit() persists a log row and broadcasts a message with the log payload', () => {
    const e = build()
    e.emit('info', 'gather/transcripts', 'pulling 3 conversations', { count: 3 })
    const logs = store.getLogs('recap_p1')
    expect(logs.length).toBe(1)
    expect(logs[0].level).toBe('info')
    expect(logs[0].phase).toBe('gather/transcripts')
    expect(logs[0].message).toBe('pulling 3 conversations')
    expect(logs[0].data).toEqual({ count: 3 })
    expect(messages.length).toBe(1)
    expect(messages[0].log?.message).toBe('pulling 3 conversations')
  })

  it('setProgress clamps and persists the new progress + phase', () => {
    const e = build()
    e.setProgress(150, 'render/llm')
    const row = store.get('recap_p1')
    expect(row?.progress).toBe(100)
    expect(row?.phase).toBe('render/llm')
    expect(messages[0].progress).toBe(100)
    expect(messages[0].phase).toBe('render/llm')
  })

  it('setStatus persists status transitions', () => {
    const e = build()
    e.setStatus('gathering')
    e.setStatus('rendering')
    expect(store.get('recap_p1')?.status).toBe('rendering')
    expect(messages.map(m => m.status)).toEqual(['gathering', 'rendering'])
  })
})
