/**
 * Replay buffer for stream-json backend.
 * Accumulates replayed entries from --resume, flushes as isInitial=true.
 */

import type { TranscriptEntry } from '../shared/protocol'
import { debug as _debug } from './debug'

const debug = (msg: string) => _debug(`[stream] ${msg}`)

const MAX_INITIAL_ENTRIES = 500
const METADATA_TYPES = new Set(['summary', 'custom-title', 'agent-name', 'pr-link'])

export interface ReplayBuffer {
  entries: TranscriptEntry[]
  done: boolean
}

export function createReplayBuffer(): ReplayBuffer {
  return { entries: [], done: false }
}

export function flushReplayBuffer(
  buf: ReplayBuffer,
  onTranscriptEntries?: (entries: TranscriptEntry[], isInitial: boolean) => void,
) {
  if (buf.done) return
  buf.done = true
  if (buf.entries.length === 0) return

  debug(`Flushing replay buffer: ${buf.entries.length} entries (isInitial=true)`)
  let entries = buf.entries
  if (entries.length > MAX_INITIAL_ENTRIES) {
    const tail = entries.slice(-MAX_INITIAL_ENTRIES)
    const tailSet = new Set(tail)
    const metadata = entries.filter(
      (e) => METADATA_TYPES.has((e as Record<string, unknown>).type as string) && !tailSet.has(e),
    )
    entries = [...metadata, ...tail]
  }
  onTranscriptEntries?.(entries, true)
  buf.entries = []
}
