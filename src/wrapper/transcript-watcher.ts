/**
 * Transcript JSONL File Watcher
 * Watches Claude transcript files for new entries, parses them,
 * processes inline images (extract base64 -> blob hash), and emits entries.
 */

import { watch, type FSWatcher } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import type { TranscriptEntry } from '../shared/protocol'

export interface TranscriptWatcherOptions {
  onEntries: (entries: TranscriptEntry[], isInitial: boolean) => void
  onError?: (error: Error) => void
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
  const { onEntries, onError } = options

  let fileHandle: FileHandle | null = null
  let fsWatcher: FSWatcher | null = null
  let offset = 0
  let entryCount = 0
  let partial = '' // leftover bytes from incomplete last line
  let reading = false
  let stopped = false
  let filePath = ''
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function readNewLines(isInitial: boolean): Promise<void> {
    if (reading || stopped || !fileHandle) return
    reading = true

    try {
      const { size } = await stat(filePath)
      if (size <= offset) {
        reading = false
        return
      }

      const buf = Buffer.alloc(size - offset)
      const { bytesRead } = await fileHandle.read(buf, 0, buf.length, offset)
      if (bytesRead === 0) {
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
          // Skip malformed lines
        }
      }

      if (entries.length > 0) {
        entryCount += entries.length
        onEntries(entries, isInitial)
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

    // Wait for file to exist (it may not exist yet when SessionStart fires)
    let attempts = 0
    while (attempts < 30 && !stopped) {
      try {
        await stat(path)
        break
      } catch {
        attempts++
        await new Promise(r => setTimeout(r, 500))
      }
    }

    if (stopped) return

    try {
      fileHandle = await open(path, 'r')
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(`Cannot open transcript: ${err}`))
      return
    }

    // Read existing content as initial batch
    await readNewLines(true)

    // Watch for changes
    try {
      fsWatcher = watch(path, () => {
        readNewLines(false)
      })
      fsWatcher.on('error', () => {
        // File might be renamed/deleted, ignore
      })
    } catch {
      // fs.watch not available or path issues - fall back to polling only
    }

    // Poll as backup (fs.watch can miss events on some filesystems)
    pollTimer = setInterval(() => {
      readNewLines(false)
    }, 1000)
  }

  function stop(): void {
    stopped = true
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (fsWatcher) {
      fsWatcher.close()
      fsWatcher = null
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
