/**
 * Handlers for agent->client requests in ACP.
 *
 * The ACP spec lets the agent call back into the client for filesystem reads,
 * filesystem writes, terminal lifecycle, and permission decisions. Native ACP
 * agents use these to varying degrees -- e.g. OpenCode runs bash in-process
 * and ignores `terminal/*` -- but the host has to answer when called.
 *
 * Permission policy is tier-driven. The host answers `session/request_permission`
 * itself based on the configured tier, **without** broadcasting to the
 * dashboard. That's a deliberate design choice: it makes tiers fast (no
 * round-trip to a human), deterministic, and consistent with the
 * pre-emptive `permission` config we set on OpenCode. A future "ask" tier
 * would route to the dashboard via the broker; that wiring is left for
 * Phase 2.5.
 *
 * All handlers are pure-ish: they take a `Deps` bundle and a request, return
 * a response. No side-effects on the broker WS, no global state. Easy to test.
 */

import { readFile, writeFile } from 'node:fs/promises'

/**
 * The same three tiers as the OpenCode NDJSON path. Reused unchanged because
 * the policy is identical -- only the *enforcement mechanism* differs (per-call
 * permission requests vs. up-front config).
 */
export type AcpToolPermissionTier = 'none' | 'safe' | 'full'

/**
 * Tool kinds that 'safe' tier rejects. Deny-list, not allow-list -- unknown
 * kinds default to allow because OpenCode (and other agents) emit
 * `kind: 'other'` for legit read-family tools like `glob` and `ls`. Blocking
 * 'other' across the board would loop the model on conversations that need
 * non-canonical-but-harmless tools.
 *
 * The ACP spec's enum is `read`, `edit`, `delete`, `move`, `search`,
 * `execute`, `think`, `fetch`, `other`. The mutating subset is what we
 * always reject under 'safe'.
 */
const SAFE_DENY_KINDS = new Set(['execute', 'edit', 'delete', 'move'])

export interface AcpToolCallEnvelope {
  toolCallId: string
  kind?: string
  title?: string
  rawInput?: unknown
}

/** Outcome shape per ACP spec: `{ outcome: 'selected', optionId: '...' }`. */
export interface PermissionOutcome {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
}

/**
 * Decide a permission outcome based on tier + tool kind. The optionId values
 * (`once`, `always`, `reject`) match what OpenCode sends in the `options`
 * array of `session/request_permission`. Other agents may use different
 * optionIds -- callers that want strict matching should inspect the request's
 * options and pick by `kind: 'allow_once' | 'reject_once' | ...` instead.
 */
export function decidePermission(tier: AcpToolPermissionTier, toolCall: AcpToolCallEnvelope): PermissionOutcome {
  if (tier === 'full') {
    return { outcome: { outcome: 'selected', optionId: 'once' } }
  }
  if (tier === 'none') {
    return { outcome: { outcome: 'selected', optionId: 'reject' } }
  }
  // safe: deny mutating kinds (execute/edit/delete/move). Allow everything
  // else -- including the 'other' bucket OpenCode uses for glob/ls/etc. A
  // missing kind also passes through as allow because the agent's permission
  // policy preamble (recipe.prepare()) only opts the *known* mutating tools
  // into 'ask' mode. If a known-bad tool slips through with no kind, that's
  // an agent-side bug we can't fix here.
  const kind = (toolCall.kind ?? '').toLowerCase()
  if (SAFE_DENY_KINDS.has(kind)) return { outcome: { outcome: 'selected', optionId: 'reject' } }
  return { outcome: { outcome: 'selected', optionId: 'once' } }
}

/**
 * Match a decided optionId to the actual options array sent by the agent.
 * Different agents use different `optionId` strings -- the spec says clients
 * MUST select one of the offered options, so we map our intent ('allow' vs
 * 'reject') to whichever offered option has the matching `kind`.
 *
 * Returns the actual optionId to send back, or null if no matching option
 * was offered (caller should fall through to error or cancellation).
 */
export interface AcpPermissionOption {
  optionId: string
  kind?: string
  name?: string
}

export type DecidedAction = 'allow' | 'reject'

export function pickOptionId(action: DecidedAction, options: AcpPermissionOption[]): string | null {
  // ACP defines option `kind` values: allow_once, allow_always, reject_once, reject_always.
  // We prefer "_once" variants -- never elevate to "_always" without explicit policy.
  const wanted = action === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const w of wanted) {
    const hit = options.find(o => o.kind === w)
    if (hit) return hit.optionId
  }
  return null
}

/**
 * Filesystem read handler. Returns the file's text content per ACP
 * `fs/read_text_file` shape. Reads are unrestricted today -- the ACP host
 * trusts the agent to only request paths inside the conversation cwd. A
 * future hardening pass can sandbox this against `cwd`.
 */
export async function handleFsRead(req: { path: string; line?: number; limit?: number }): Promise<{ content: string }> {
  const text = await readFile(req.path, 'utf8')
  if (req.line === undefined && req.limit === undefined) return { content: text }
  // Optional line/limit slicing per spec.
  const lines = text.split('\n')
  const start = Math.max(0, (req.line ?? 1) - 1)
  const end = req.limit !== undefined ? start + req.limit : lines.length
  return { content: lines.slice(start, end).join('\n') }
}

/**
 * Filesystem write handler. Writes the supplied content. Like reads, this is
 * intentionally unsandboxed today; tighten later.
 */
export async function handleFsWrite(req: { path: string; content: string }): Promise<Record<string, never>> {
  await writeFile(req.path, req.content, 'utf8')
  return {}
}

/**
 * The host doesn't expose terminals to the agent -- OpenCode runs bash
 * in-process and Codex/Gemini-via-adapter typically do too. If an agent
 * asks for one, we return a method-not-implemented error and let the agent
 * decide how to fall back.
 */
export const TERMINAL_NOT_IMPLEMENTED_ERROR = {
  code: -32601 as const,
  message: 'terminal/* not supported by this ACP host (agent should run subprocesses internally)' as const,
}
