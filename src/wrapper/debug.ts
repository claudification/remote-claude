import { appendFileSync } from 'node:fs'

export const DEBUG = !!process.env.RCLAUDE_DEBUG
const DEBUG_LOG = process.env.RCLAUDE_DEBUG_LOG || (DEBUG ? '/tmp/rclaude-debug.log' : '')

export function debug(msg: string) {
  if (!DEBUG) return
  const line = `[${new Date().toISOString()}] ${msg}\n`
  if (DEBUG_LOG) {
    try {
      appendFileSync(DEBUG_LOG, line)
    } catch {}
  } else {
    console.error(`[rclaude] ${msg}`)
  }
}
