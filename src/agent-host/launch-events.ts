/**
 * Launch Events
 *
 * Structured, persistent timeline of the CC process launching, re-launching
 * (on /clear), and settling on a session id. Rendered inline in the dashboard
 * transcript so the user always sees which CC they're talking to and how it
 * was launched. Distinct from boot events (boot_event) which only cover the
 * initial boot phase and are used for the "boot monitor" UI.
 *
 * Emit flow:
 *   Initial spawn:
 *     launch_started -> init_received -> rekeyed (boot) -> ready
 *   /clear reboot:
 *     clear_requested -> process_killed -> mcp_reset -> settings_regenerated
 *     -> launch_started -> init_received -> rekeyed -> ready
 *
 * Env filtering: only RCLAUDE_* / CLAUDE_* / ANTHROPIC_* vars plus a few
 * terminal basics (CI, TERM) and any customEnv explicitly set by the wrapper
 * make it into `raw`. Shell noise (HOMEBREW_PREFIX, PATH, ...) is stripped
 * so the (i) inspector stays readable.
 */

import { randomUUID } from 'node:crypto'
import type { WrapperLaunchEvent, WrapperLaunchPhase, WrapperLaunchStep } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'

const RELEVANT_ENV_PREFIXES = ['RCLAUDE_', 'CLAUDE_', 'ANTHROPIC_']
const RELEVANT_ENV_NAMES = new Set(['CI', 'TERM', 'NODE_ENV', 'TZ', 'LANG'])

/** Filter a full env map down to rclaude/claude/anthropic-relevant keys.
 *  `customEnv` keys (explicitly set by wrapper) are always included. */
export function filterRelevantEnv(
  fullEnv: Record<string, string | undefined>,
  customEnv?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fullEnv)) {
    if (v == null) continue
    if (RELEVANT_ENV_NAMES.has(k) || RELEVANT_ENV_PREFIXES.some(p => k.startsWith(p))) {
      out[k] = v
    }
  }
  if (customEnv) {
    for (const [k, v] of Object.entries(customEnv)) {
      out[k] = v
    }
  }
  // Redact secrets even among the relevant set -- these are sent over WS and
  // stored forever on the broker. Safer to mask.
  for (const k of Object.keys(out)) {
    if (/SECRET|TOKEN|KEY|PASSWORD/i.test(k)) {
      out[k] = `***${out[k].length > 4 ? `(${out[k].length} chars)` : ''}`
    }
  }
  return out
}

/**
 * Start a fresh launch. Generates a new launchId and updates ctx state.
 * Returns the new launchId so callers can correlate events if needed.
 */
export function beginLaunch(ctx: AgentHostContext, phase: WrapperLaunchPhase): string {
  ctx.currentLaunchId = randomUUID()
  ctx.currentLaunchPhase = phase
  return ctx.currentLaunchId
}

/**
 * Emit one launch event. Appends to ctx.launchEvents (for reconnect replay)
 * and ships it over WS if connected.
 */
export function emitLaunchEvent(
  ctx: AgentHostContext,
  step: WrapperLaunchStep,
  opts: { detail?: string; raw?: Record<string, unknown> } = {},
): void {
  const evt: WrapperLaunchEvent = {
    type: 'launch_event',
    conversationId: ctx.conversationId,
    launchId: ctx.currentLaunchId,
    phase: ctx.currentLaunchPhase,
    step,
    ccSessionId: ctx.claudeSessionId,
    detail: opts.detail,
    raw: opts.raw,
    t: Date.now(),
  }
  ctx.launchEvents.push(evt)
  // Cap to 500 events across all launches in this wrapper lifetime -- lets us
  // replay on reconnect without memory growth in very long-running sessions.
  if (ctx.launchEvents.length > 500) {
    ctx.launchEvents.splice(0, ctx.launchEvents.length - 500)
  }
  if (ctx.wsClient?.isConnected()) {
    ctx.wsClient.send(evt)
  }
  ctx.debug(`[launch] ${ctx.currentLaunchPhase}/${step}${opts.detail ? ` ${opts.detail}` : ''}`)
}

/** Resend every buffered launch event. Called on WS (re)connect so late
 *  subscribers see the full timeline. */
export function replayLaunchEvents(ctx: AgentHostContext): void {
  if (!ctx.wsClient?.isConnected()) return
  for (const evt of ctx.launchEvents) {
    ctx.wsClient.send(evt)
  }
}
