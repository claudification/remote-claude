import { appendFileSync } from 'node:fs'

export const DEBUG = !!process.env.RCLAUDE_DEBUG
const DEBUG_LOG = process.env.RCLAUDE_DEBUG_LOG || '/tmp/rclaude-debug.log'

// In headless mode, debug can safely go to stderr (no PTY to corrupt)
let useStderr = false

export function setDebugStderr(enabled: boolean) {
  useStderr = enabled
}

/**
 * Debug logging -- writes to file in PTY mode, stderr in headless mode.
 * PTY mode: console output would corrupt the terminal display.
 * Headless mode: no PTY, stderr is safe and more convenient.
 */
export function debug(msg: string) {
  if (!DEBUG) return
  const line = `[${new Date().toISOString()}] ${msg}`
  if (useStderr) {
    process.stderr.write(`${line}\n`)
  }
  try {
    appendFileSync(DEBUG_LOG, `${line}\n`)
  } catch {}
}
