/**
 * Transcript JSONL File Watcher
 * Watches Claude transcript files for new entries, parses them,
 * processes inline images (extract base64 -> blob hash), and emits entries.
 *
 * Uses directory-level chokidar watching instead of file-level to work around
 * a Bun fs.watch bug on macOS where closing a file watcher and starting a new
 * one on a different file in the same directory causes events to silently stop.
 * This happens on /clear and compaction which create new transcript files.
 */

import { type FileHandle, open, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { type FSWatcher as ChokidarWatcher, watch as chokidarWatch } from 'chokidar'
import type { TranscriptEntry } from '../shared/protocol'

/** Parse JSONL lines with Bun.JSONL fast path + manual fallback */
function parseJsonlLines(lines: string[], debug?: (msg: string) => void): TranscriptEntry[] {
  if (typeof Bun !== 'undefined' && Bun.JSONL) {
    try {
      const text = lines.filter(l => l.trim()).join('\n')
      if (!text) return []
      return Bun.JSONL.parse(text) as TranscriptEntry[]
    } catch {
      debug?.('Bun.JSONL.parse failed, falling back to per-line parsing')
    }
  }
  const entries: TranscriptEntry[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry)
    } catch {
      debug?.(`malformed JSON line (${trimmed.length} chars)`)
    }
  }
  return entries
}

export interface TranscriptWatcherOptions {
  onEntries: (entries: TranscriptEntry[], isInitial: boolean) => void
  onNewFile?: (filename: string) => void
  onError?: (error: Error) => void
  debug?: (msg: string) => void
}

export interface TranscriptWatcher {
  start: (path: string) => Promise<void>
  stop: () => void
  resend: () => Promise<void>
  getEntryCount: () => number
}

/**
 * Create a watcher for a single JSONL transcript file.
 * Reads from the last known offset, parses new lines, emits entries.
 */
export function createTranscriptWatcher(options: TranscriptWatcherOptions): TranscriptWatcher {
  const { onEntries, onNewFile, onError, debug } = options

  let fileHandle: FileHandle | null = null
  let watcher: ChokidarWatcher | null = null
  let offset = 0
  let entryCount = 0
  let partial = '' // leftover bytes from incomplete last line
  let reading = false
  let pendingRead = false
  let stopped = false
  let filePath = ''

  async function readNewLines(isInitial_: boolean): Promise<void> {
    let isInitial = isInitial_
    if (reading || stopped || !fileHandle) {
      if (reading && !stopped) pendingRead = true
      return
    }
    reading = true

    try {
      const { size } = await stat(filePath)
      if (size < offset) {
        // File was truncated/compacted (Claude Code context compression rewrites the JSONL)
        debug?.(`readNewLines: file truncated (size=${size} < offset=${offset}), resetting`)
        offset = 0
        partial = ''
        entryCount = 0
        // Re-read as initial batch since the old data is gone
        isInitial = true
      }
      if (size === offset) {
        reading = false
        return
      }

      debug?.(`readNewLines: size=${size} offset=${offset} toRead=${size - offset}`)

      const buf = Buffer.allocUnsafe(size - offset)
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

      const entries = parseJsonlLines(lines, debug)

      debug?.(`readNewLines: ${lines.length} lines, ${entries.length} entries, partial=${partial.length} chars`)

      if (entries.length > 0) {
        entryCount += entries.length
        if (isInitial && entries.length > 500) {
          // On initial read, send the tail (ring buffer caps at 500) but preserve
          // metadata entries from earlier in the transcript (summary, title, pr-link, etc.)
          const METADATA_TYPES = new Set(['summary', 'custom-title', 'agent-name', 'pr-link'])
          const tail = entries.slice(-500)
          const tailSet = new Set(tail)
          const metadata = entries.filter(
            e => METADATA_TYPES.has((e as Record<string, unknown>).type as string) && !tailSet.has(e),
          )
          onEntries([...metadata, ...tail], isInitial)
        } else {
          onEntries(entries, isInitial)
        }
      }
    } catch (err) {
      if (!stopped) {
        onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      reading = false
      if (pendingRead) {
        pendingRead = false
        readNewLines(false)
      }
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

    // Watch the PARENT DIRECTORY instead of the file directly.
    // Bun's fs.watch on macOS silently stops firing events after closing a file
    // watcher and starting a new one on a different file in the same directory.
    // /clear and compaction create new transcript files in the same dir, triggering
    // this bug. Directory-level watching is immune.
    const dir = dirname(path)
    const absPath = resolve(path)
    watcher = chokidarWatch(dir, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: false,
    })
    watcher.on('change', changedPath => {
      if (resolve(changedPath) === absPath) {
        debug?.(`chokidar change event`)
        readNewLines(false)
      }
    })
    watcher.on('add', addedPath => {
      const name = addedPath.split('/').pop() || addedPath
      if (name.endsWith('.jsonl')) {
        debug?.(`New transcript file detected: ${name}`)
        onNewFile?.(name)
      }
    })
    debug?.(`Chokidar dir watcher setup OK: ${dir}`)
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

  async function resend(): Promise<void> {
    if (!filePath || stopped) return
    debug?.(`resend: re-reading full file from offset 0`)
    // Re-read entire file from start, emit as initial
    const savedOffset = offset
    offset = 0
    partial = ''
    reading = false
    pendingRead = false
    await readNewLines(true)
    debug?.(`resend: done, offset now ${offset} (was ${savedOffset})`)
  }

  function getEntryCount(): number {
    return entryCount
  }

  return { start, stop, resend, getEntryCount }
}
