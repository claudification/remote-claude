/**
 * Client-side log capture
 * Intercepts console.log/warn/error/debug into a ring buffer.
 * Import this module once (e.g. in main.tsx) to start capturing.
 */

export type LogLevel = 'log' | 'warn' | 'error' | 'debug'

export interface LogEntry {
  t: number
  level: LogLevel
  args: string
}

const MAX_ENTRIES = 500
const entries: LogEntry[] = []
const listeners = new Set<() => void>()

// Preserve originals
const originals = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
}

function formatArgs(args: unknown[]): string {
  return args
    .map(a => {
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a, null, 2)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

function capture(level: LogLevel, args: unknown[]) {
  const entry: LogEntry = { t: Date.now(), level, args: formatArgs(args) }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.shift()
  for (const fn of listeners) fn()
}

let installed = false

export function installLogCapture() {
  if (installed) return
  installed = true

  console.log = (...args: unknown[]) => {
    originals.log(...args)
    capture('log', args)
  }
  console.warn = (...args: unknown[]) => {
    originals.warn(...args)
    capture('warn', args)
  }
  console.error = (...args: unknown[]) => {
    originals.error(...args)
    capture('error', args)
  }
  console.debug = (...args: unknown[]) => {
    originals.debug(...args)
    capture('debug', args)
  }

  // Capture uncaught errors + promise rejections
  window.addEventListener('error', e => {
    capture('error', [`[uncaught] ${e.message} at ${e.filename}:${e.lineno}`])
  })
  window.addEventListener('unhandledrejection', e => {
    capture('error', [`[unhandled rejection] ${e.reason}`])
  })
}

export function getLogEntries(): LogEntry[] {
  return entries
}

export function clearLog() {
  entries.length = 0
  for (const fn of listeners) fn()
}

export function subscribeLog(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function copyLogText(maxLines = 200): string {
  const slice = entries.slice(-maxLines)
  return slice
    .map(e => {
      const ts = new Date(e.t).toISOString().slice(11, 23)
      const lvl = e.level.toUpperCase().padEnd(5)
      return `${ts} ${lvl} ${e.args}`
    })
    .join('\n')
}
