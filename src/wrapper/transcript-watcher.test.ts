import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TranscriptEntry } from '../shared/protocol'
import { createTranscriptWatcher } from './transcript-watcher'

describe('TranscriptWatcher', () => {
  let tempDir: string
  let testFile: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tw-test-'))
    testFile = join(tempDir, 'transcript.jsonl')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('reads existing entries on start as initial batch', async () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { content: 'hello' } },
      { type: 'assistant', message: { content: 'world' } },
    ]
    await writeFile(testFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n')

    const received: { entries: TranscriptEntry[]; isInitial: boolean }[] = []
    const watcher = createTranscriptWatcher({
      onEntries(entries, isInitial) {
        received.push({ entries: [...entries], isInitial })
      },
    })

    await watcher.start(testFile)
    // Give it a moment to read
    await delay(100)

    expect(received.length).toBe(1)
    expect(received[0].isInitial).toBe(true)
    expect(received[0].entries.length).toBe(2)
    expect(received[0].entries[0]).toEqual(entries[0])
    expect(received[0].entries[1]).toEqual(entries[1])
    expect(watcher.getEntryCount()).toBe(2)

    watcher.stop()
  })

  it('detects new entries appended to file', async () => {
    await writeFile(testFile, '')

    const received: { entries: TranscriptEntry[]; isInitial: boolean }[] = []
    const watcher = createTranscriptWatcher({
      onEntries(entries, isInitial) {
        received.push({ entries: [...entries], isInitial })
      },
    })

    await watcher.start(testFile)
    await delay(100)

    // Append new entries
    const entry = { type: 'user', message: { content: 'new entry' } }
    await appendFile(testFile, JSON.stringify(entry) + '\n')

    // Wait for fs.watch/poll to pick it up
    await delay(1500)

    const incremental = received.filter(r => !r.isInitial)
    expect(incremental.length).toBeGreaterThanOrEqual(1)
    const allEntries = incremental.flatMap(r => r.entries)
    expect(allEntries.length).toBe(1)
    expect(allEntries[0]).toEqual(entry)

    watcher.stop()
  })

  it('handles partial lines (incomplete writes)', async () => {
    await writeFile(testFile, '')

    const received: TranscriptEntry[] = []
    const watcher = createTranscriptWatcher({
      onEntries(entries) {
        received.push(...entries)
      },
    })

    await watcher.start(testFile)
    await delay(100)

    // Write partial JSON (no newline)
    const entry = { type: 'assistant', message: { content: 'partial' } }
    const json = JSON.stringify(entry)
    await appendFile(testFile, json.slice(0, 20))
    await delay(1500)

    // Nothing should be emitted yet (incomplete line)
    expect(received.length).toBe(0)

    // Complete the line
    await appendFile(testFile, json.slice(20) + '\n')
    await delay(1500)

    // Now it should be emitted
    expect(received.length).toBe(1)
    expect(received[0]).toEqual(entry)

    watcher.stop()
  })

  it('skips malformed JSON lines', async () => {
    const validEntry = { type: 'user', message: { content: 'valid' } }
    const content = [
      'not valid json',
      JSON.stringify(validEntry),
      '{ broken: }',
    ].join('\n') + '\n'

    await writeFile(testFile, content)

    const received: TranscriptEntry[] = []
    const watcher = createTranscriptWatcher({
      onEntries(entries) {
        received.push(...entries)
      },
    })

    await watcher.start(testFile)
    await delay(100)

    expect(received.length).toBe(1)
    expect(received[0]).toEqual(validEntry)

    watcher.stop()
  })

  it('waits for file to appear if it does not exist yet', async () => {
    const latePath = join(tempDir, 'late.jsonl')

    const received: TranscriptEntry[] = []
    const watcher = createTranscriptWatcher({
      onEntries(entries) {
        received.push(...entries)
      },
    })

    // Start watching before file exists
    const startPromise = watcher.start(latePath)

    // Create file after a delay
    await delay(600)
    const entry = { type: 'user', message: { content: 'late arrival' } }
    await writeFile(latePath, JSON.stringify(entry) + '\n')

    await startPromise
    await delay(100)

    expect(received.length).toBe(1)
    expect(received[0]).toEqual(entry)

    watcher.stop()
  })

  it('stops cleanly and does not emit after stop', async () => {
    const entry = { type: 'user', message: { content: 'before stop' } }
    await writeFile(testFile, JSON.stringify(entry) + '\n')

    let emitCount = 0
    const watcher = createTranscriptWatcher({
      onEntries() {
        emitCount++
      },
    })

    await watcher.start(testFile)
    await delay(100)
    expect(emitCount).toBe(1)

    watcher.stop()

    // Append after stop - should not trigger
    await appendFile(testFile, JSON.stringify({ type: 'user', message: { content: 'after stop' } }) + '\n')
    await delay(1500)

    expect(emitCount).toBe(1)
  })

  it('handles multiple rapid appends', async () => {
    await writeFile(testFile, '')

    const received: TranscriptEntry[] = []
    const watcher = createTranscriptWatcher({
      onEntries(entries) {
        received.push(...entries)
      },
    })

    await watcher.start(testFile)
    await delay(100)

    // Rapid-fire appends
    const count = 10
    for (let i = 0; i < count; i++) {
      await appendFile(testFile, JSON.stringify({ type: 'user', index: i }) + '\n')
    }

    await delay(2000)

    expect(received.length).toBe(count)
    for (let i = 0; i < count; i++) {
      expect(received[i]).toEqual({ type: 'user', index: i })
    }
    expect(watcher.getEntryCount()).toBe(count)

    watcher.stop()
  })

  it('handles empty file', async () => {
    await writeFile(testFile, '')

    const received: TranscriptEntry[] = []
    const watcher = createTranscriptWatcher({
      onEntries(entries) {
        received.push(...entries)
      },
    })

    await watcher.start(testFile)
    await delay(100)

    expect(received.length).toBe(0)
    expect(watcher.getEntryCount()).toBe(0)

    watcher.stop()
  })
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
