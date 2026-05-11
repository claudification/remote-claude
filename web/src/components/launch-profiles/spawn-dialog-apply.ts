/**
 * Bridge between LaunchProfile.spawn and the spawn-dialog form state.
 *
 * The dialog already owns per-field useState setters; this module
 * provides a single applyProfileToForm() helper so the dropdown's
 * onChange handler doesn't pollute the dialog body.
 */

import type { LaunchProfile } from '@shared/launch-profile'

export type BackendKind = 'claude' | 'chat-api' | 'hermes' | 'opencode'

export interface SpawnFormSetters {
  setHeadless: (v: boolean) => void
  setModel: (v: string) => void
  setEffort: (v: string) => void
  setAgent: (v: string) => void
  setBare: (v: boolean) => void
  setRepl: (v: boolean) => void
  setPermissionMode: (v: string) => void
  setAutocompactPct: (v: number | '') => void
  setMaxBudgetUsd: (v: string) => void
  setIncludePartialMessages: (v: boolean) => void
  setBackend: (v: BackendKind) => void
  setEnvText: (v: string) => void
  setOpenCodeModel?: (v: string) => void
  setOpenCodeToolPermission?: (v: 'none' | 'safe' | 'full') => void
}

export function applyProfileToForm(profile: LaunchProfile, setters: SpawnFormSetters): void {
  const s = profile.spawn
  if (s.headless !== undefined) setters.setHeadless(s.headless)
  setters.setModel(s.model ?? '')
  setters.setEffort(s.effort ?? '')
  setters.setAgent(s.agent ?? '')
  setters.setBare(s.bare ?? false)
  setters.setRepl(s.repl ?? false)
  setters.setPermissionMode(s.permissionMode ?? '')
  setters.setAutocompactPct(s.autocompactPct ?? '')
  setters.setMaxBudgetUsd(s.maxBudgetUsd != null ? String(s.maxBudgetUsd) : '')
  if (s.includePartialMessages !== undefined) setters.setIncludePartialMessages(s.includePartialMessages)
  if (s.backend) setters.setBackend(s.backend as BackendKind)
  setters.setEnvText(envObjectToText(s.env))
  if (s.openCodeModel && setters.setOpenCodeModel) setters.setOpenCodeModel(s.openCodeModel)
  if (s.toolPermission && setters.setOpenCodeToolPermission) setters.setOpenCodeToolPermission(s.toolPermission)
}

function envObjectToText(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

export interface FormSnapshotInput {
  model: string
  effort: string
  agent: string
  permissionMode: string
  autocompactPct: number | ''
  maxBudgetUsd: string
  headless: boolean
  bare: boolean
  repl: boolean
  includePartialMessages: boolean
  backend: BackendKind
  envText: string
  openCodeModel?: string
  toolPermission?: 'none' | 'safe' | 'full'
}

/**
 * Capture the spawn dialog's current form state as a profile draft so the
 * user can hit "Save as profile..." without retyping anything.
 */
export function formSnapshotToProfileSpawn(snap: FormSnapshotInput): LaunchProfile['spawn'] {
  const out: LaunchProfile['spawn'] = {}
  if (snap.model) out.model = snap.model as LaunchProfile['spawn']['model']
  if (snap.effort) out.effort = snap.effort as LaunchProfile['spawn']['effort']
  if (snap.agent) out.agent = snap.agent
  if (snap.permissionMode) {
    out.permissionMode = snap.permissionMode as LaunchProfile['spawn']['permissionMode']
  }
  if (snap.autocompactPct !== '') out.autocompactPct = Number(snap.autocompactPct)
  const budgetNum = Number(snap.maxBudgetUsd)
  if (Number.isFinite(budgetNum) && budgetNum > 0) out.maxBudgetUsd = budgetNum
  out.headless = snap.headless
  if (snap.bare) out.bare = true
  if (snap.repl) out.repl = true
  out.includePartialMessages = snap.includePartialMessages
  if (snap.backend !== 'claude') out.backend = snap.backend
  const env = parseEnvSimple(snap.envText)
  if (env && Object.keys(env).length) out.env = env
  if (snap.openCodeModel) out.openCodeModel = snap.openCodeModel
  if (snap.toolPermission) out.toolPermission = snap.toolPermission
  return out
}

function parseEnvSimple(text: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}
