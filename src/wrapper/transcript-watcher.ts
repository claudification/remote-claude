/**
 * Transcript JSONL File Watcher
 * Watches Claude transcript files for new entries, parses them,
 * processes inline images (extract base64 -> blob hash), and emits entries.
 */

import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from 'chokidar'
import { open, stat, type FileHandle } from 'node:fs/promises'
import type { TranscriptEntry } from '../shared/protocol'

export interface TranscriptWatcherOptions {
  onEntries: (entries: TranscriptEntry[], isInitial: boolean) => void
  onError?: (error: Error) => void
  debug?: (msg: string) => void
}

export interface TranscriptWatcher {
  start: (path: string) => Promise<void>
  stop: () => void
  getEntryCount: () => number
}

/**
 * Create a watcher for a single JSONL transcript file.
 * Reads from the last known offset, parses new lines, emits entries.
 */
export function createTranscriptWatcher(options: TranscriptWatcherOptions): TranscriptWatcher {
  const { onEntries, onError, debug } = options

  let fileHandle: FileHandle | null = null
  let watcher: ChokidarWatcher | null = null
  let offset = 0
  let entryCount = 0
  let partial = '' // leftover bytes from incomplete last line
  let reading = false
  let stopped = false
  let filePath = ''

  async function readNewLines(isInitial: boolean): Promise<void> {
    if (reading || stopped || !fileHandle) return
    reading = true

    try {
      const { size } = await stat(filePath)
      if (size <= offset) {
        reading = false
        return
      }

      debug?.(`readNewLines: size=${size} offset=${offset} toRead=${size - offset}`)

      const buf = Buffer.alloc(size - offset)
      const { bytesRead } = await fileHandle.read(buf, 0, buf.length, offset)
      if (bytesRead === 0) {
        debug?.(`readNewLines: 0 bytes read despite size delta`)
        reading = false
        return
      }
      offset += bytesRead

      const text = partial + buf.toString('utf-8', 0, bytesRead)
      const lines = text.split('\n')

      // Last element might be incomplete if file is still being written
      partial = lines.pop() || ''

      const entries: TranscriptEntry[] = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          entries.push(JSON.parse(trimmed) as TranscriptEntry)
        } catch {
          debug?.(`readNewLines: malformed JSON line (${trimmed.length} chars)`)
        }
      }

      debug?.(`readNewLines: ${lines.length} lines, ${entries.length} entries, partial=${partial.length} chars`)

      if (entries.length > 0) {
        entryCount += entries.length
        // On initial read, only send the tail - concentrator ring buffer caps at 500 anyway
        const toSend = isInitial && entries.length > 500 ? entries.slice(-500) : entries
        onEntries(toSend, isInitial)
      }
    } catch (err) {
      if (!stopped) {
        onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      reading = false
    }
  }

  async function start(path: string): Promise<void> {
    filePath = path
    stopped = false
    offset = 0
    partial = ''
    entryCount = 0

    try {
      fileHandle = await open(path, 'r')
      debug?.(`File opened OK`)
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(`Cannot open transcript: ${err}`))
      return
    }

    // Read existing content as initial batch
    await readNewLines(true)
    debug?.(`Initial read done, entryCount=${entryCount}`)

    // Watch for changes with chokidar
    watcher = chokidarWatch(path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    })
    watcher.on('change', () => {
      debug?.(`chokidar change event`)
      readNewLines(false)
    })
    debug?.(`Chokidar watcher setup OK`)
  }

  function stop(): void {
    stopped = true
    if (watcher) {
      watcher.close()
      watcher = null
    }
    if (fileHandle) {
      fileHandle.close().catch(() => {})
      fileHandle = null
    }
  }

  function getEntryCount(): number {
    return entryCount
  }

  return { start, stop, getEntryCount }
}
