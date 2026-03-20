import { appendFileSync } from 'node:fs'

export const DEBUG = !!process.env.RCLAUDE_DEBUG
const DEBUG_LOG = process.env.RCLAUDE_DEBUG_LOG || '/tmp/rclaude-debug.log'

/**
 * Debug logging -- always writes to file, NEVER to console/stderr.
 * rclaude shares a PTY with Claude Code, so any console output
 * would corrupt the terminal display.
 */
export function debug(msg: string) {
  if (!DEBUG) return
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}
