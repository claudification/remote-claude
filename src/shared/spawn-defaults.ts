/**
 * Canonical resolver for spawn request defaults.
 *
 * Merges `explicit > project > global > undefined` across every field that
 * has a settings-backed default. Consumed by:
 * - HTTP /api/spawn route (src/broker/routes.ts)
 * - HTTP /conversations/:id/revive route
 * - WS channel_spawn handler (src/broker/handlers/inter-conversation.ts)
 *
 * Empty strings, the `'default'` sentinel, and `0` numerics (in defaults) all
 * mean "unset" -- callers downstream treat `undefined` as "use CC default".
 */

import type { LaunchProfile } from './launch-profile'
import type { SpawnRequest } from './spawn-schema'

export type DefaultsSource = {
  defaultModel?: string
  defaultEffort?: string
  defaultPermissionMode?: string
  defaultMaxBudgetUsd?: number
  defaultAutocompactPct?: number
  defaultLaunchMode?: 'headless' | 'pty'
  defaultBare?: boolean
  defaultRepl?: boolean
  defaultIncludePartialMessages?: boolean
}

/** Shape returned by resolveSpawnConfig -- `headless` is always concrete. */
export type ResolvedSpawnConfig = Partial<SpawnRequest> & { headless: boolean }

/**
 * Merge spawn request defaults: explicit > profile > project > global > undefined.
 * Empty strings, 'default' sentinel, and 0 numerics in defaults are treated as unset.
 */
export function resolveSpawnConfig(
  partial: Partial<SpawnRequest>,
  project?: DefaultsSource | null,
  global?: DefaultsSource | null,
  profile?: DefaultsSource | null,
): ResolvedSpawnConfig {
  const model = pickString(partial.model, profile?.defaultModel, project?.defaultModel, global?.defaultModel) as
    | SpawnRequest['model']
    | undefined
  const effort = pickString(partial.effort, profile?.defaultEffort, project?.defaultEffort, global?.defaultEffort) as
    | SpawnRequest['effort']
    | undefined
  const permissionModeResolved = pickString(
    partial.permissionMode,
    profile?.defaultPermissionMode,
    project?.defaultPermissionMode,
    global?.defaultPermissionMode,
  ) as SpawnRequest['permissionMode'] | undefined

  const launchMode = profile?.defaultLaunchMode || project?.defaultLaunchMode || global?.defaultLaunchMode
  const headless = partial.adHoc ? true : partial.headless !== undefined ? partial.headless : launchMode !== 'pty'

  const autocompactPct = pickNumber(
    partial.autocompactPct,
    profile?.defaultAutocompactPct,
    project?.defaultAutocompactPct,
    global?.defaultAutocompactPct,
  )
  const maxBudgetUsd = pickNumber(
    partial.maxBudgetUsd,
    profile?.defaultMaxBudgetUsd,
    project?.defaultMaxBudgetUsd,
    global?.defaultMaxBudgetUsd,
  )

  const bare = partial.bare ?? profile?.defaultBare ?? project?.defaultBare ?? global?.defaultBare ?? undefined
  const repl = partial.repl ?? profile?.defaultRepl ?? project?.defaultRepl ?? global?.defaultRepl ?? undefined

  const includePartialMessages = partial.adHoc
    ? (partial.includePartialMessages ?? false)
    : (partial.includePartialMessages ??
      profile?.defaultIncludePartialMessages ??
      project?.defaultIncludePartialMessages ??
      global?.defaultIncludePartialMessages ??
      true)

  return {
    ...partial,
    model,
    effort,
    permissionMode: partial.adHoc ? 'bypassPermissions' : permissionModeResolved,
    headless,
    autocompactPct,
    maxBudgetUsd,
    bare,
    repl,
    includePartialMessages,
  }
}

export function profileToDefaultsSource(profile: LaunchProfile | null | undefined): DefaultsSource | null {
  if (!profile) return null
  const spawn = profile.spawn
  return {
    defaultModel: spawn.model,
    defaultEffort: spawn.effort,
    defaultPermissionMode: spawn.permissionMode,
    defaultMaxBudgetUsd: spawn.maxBudgetUsd,
    defaultAutocompactPct: spawn.autocompactPct,
    defaultLaunchMode: spawn.headless === undefined ? undefined : spawn.headless ? 'headless' : 'pty',
    defaultBare: spawn.bare,
    defaultRepl: spawn.repl,
    defaultIncludePartialMessages: spawn.includePartialMessages,
  }
}

/**
 * Apply non-defaults profile fields (backend, env, prompt, appendSystemPrompt, ...)
 * that are not covered by DefaultsSource. Returns a partial that explicit form
 * values can be merged over.
 */
export function profileToSpawnPartial(profile: LaunchProfile | null | undefined): Partial<SpawnRequest> {
  if (!profile) return {}
  const spawn = profile.spawn
  const partial: Partial<SpawnRequest> = {}
  if (spawn.backend !== undefined) partial.backend = spawn.backend
  if (spawn.agent !== undefined) partial.agent = spawn.agent
  if (spawn.env !== undefined) partial.env = spawn.env
  if (spawn.appendSystemPrompt !== undefined) partial.appendSystemPrompt = spawn.appendSystemPrompt
  if (spawn.openCodeModel !== undefined) partial.openCodeModel = spawn.openCodeModel
  if (spawn.toolPermission !== undefined) partial.toolPermission = spawn.toolPermission
  if (spawn.chatConnectionId !== undefined) partial.chatConnectionId = spawn.chatConnectionId
  if (spawn.chatConnectionName !== undefined) partial.chatConnectionName = spawn.chatConnectionName
  if (spawn.gatewayId !== undefined) partial.gatewayId = spawn.gatewayId
  return partial
}

function pickString(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v && v !== 'default') return v
  }
  return undefined
}

function pickNumber(...values: Array<number | undefined>): number | undefined {
  for (const v of values) {
    if (v !== undefined && v > 0) return v
  }
  return undefined
}
