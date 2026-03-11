/**
 * WebSocket traffic stats - sliding window counters outside React/Zustand
 * Tracks messages and bytes per second over a 3-second window, updates every 300ms
 */

interface Sample {
  msgIn: number
  msgOut: number
  bytesIn: number
  bytesOut: number
  ts: number
}

const WINDOW_MS = 3000
const TICK_MS = 300

// Accumulate between ticks
let curMsgIn = 0
let curMsgOut = 0
let curBytesIn = 0
let curBytesOut = 0

// Ring of samples within the window
const samples: Sample[] = []

// Current per-second rates (what consumers read)
let rates = { msgInPerSec: 0, msgOutPerSec: 0, bytesInPerSec: 0, bytesOutPerSec: 0 }

const listeners = new Set<() => void>()

setInterval(() => {
  const now = Date.now()

  // Push current accumulation as a sample
  samples.push({ msgIn: curMsgIn, msgOut: curMsgOut, bytesIn: curBytesIn, bytesOut: curBytesOut, ts: now })
  curMsgIn = 0
  curMsgOut = 0
  curBytesIn = 0
  curBytesOut = 0

  // Drop samples older than the window
  const cutoff = now - WINDOW_MS
  while (samples.length > 0 && samples[0].ts < cutoff) samples.shift()

  // Sum over window and compute per-second rates
  let totalMsgIn = 0
  let totalMsgOut = 0
  let totalBytesIn = 0
  let totalBytesOut = 0
  for (const s of samples) {
    totalMsgIn += s.msgIn
    totalMsgOut += s.msgOut
    totalBytesIn += s.bytesIn
    totalBytesOut += s.bytesOut
  }

  const windowSec = WINDOW_MS / 1000
  rates = {
    msgInPerSec: totalMsgIn / windowSec,
    msgOutPerSec: totalMsgOut / windowSec,
    bytesInPerSec: totalBytesIn / windowSec,
    bytesOutPerSec: totalBytesOut / windowSec,
  }

  for (const fn of listeners) fn()
}, TICK_MS)

export function recordIn(bytes: number) {
  curMsgIn++
  curBytesIn += bytes
}

export function recordOut(bytes: number) {
  curMsgOut++
  curBytesOut += bytes
}

export function getRates() {
  return rates
}

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
