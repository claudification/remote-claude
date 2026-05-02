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
 * Merge spawn request defaults: explicit > project > global > undefined.
 * Empty strings, 'default' sentinel, and 0 numerics in defaults are treated as unset.
 */
export function resolveSpawnConfig(
  partial: Partial<SpawnRequest>,
  project?: DefaultsSource | null,
  global?: DefaultsSource | null,
): ResolvedSpawnConfig {
  const model = pickString(partial.model, project?.defaultModel, global?.defaultModel) as
    | SpawnRequest['model']
    | undefined
  const effort = pickString(partial.effort, project?.defaultEffort, global?.defaultEffort) as
    | SpawnRequest['effort']
    | undefined
  const permissionModeResolved = pickString(
    partial.permissionMode,
    project?.defaultPermissionMode,
    global?.defaultPermissionMode,
  ) as SpawnRequest['permissionMode'] | undefined

  // headless: adHoc always true; otherwise explicit > project > global launch mode
  const launchMode = project?.defaultLaunchMode || global?.defaultLaunchMode
  const headless = partial.adHoc ? true : partial.headless !== undefined ? partial.headless : launchMode !== 'pty'

  const autocompactPct = pickNumber(
    partial.autocompactPct,
    project?.defaultAutocompactPct,
    global?.defaultAutocompactPct,
  )
  const maxBudgetUsd = pickNumber(partial.maxBudgetUsd, project?.defaultMaxBudgetUsd, global?.defaultMaxBudgetUsd)

  const bare = partial.bare ?? project?.defaultBare ?? global?.defaultBare ?? undefined
  const repl = partial.repl ?? project?.defaultRepl ?? global?.defaultRepl ?? undefined

  // includePartialMessages: ad-hoc defaults to false, otherwise explicit > project > global > true
  const includePartialMessages = partial.adHoc
    ? (partial.includePartialMessages ?? false)
    : (partial.includePartialMessages ??
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

function pickString(
  explicit: string | undefined,
  proj: string | undefined,
  glob: string | undefined,
): string | undefined {
  const out = explicit || proj || glob
  return out && out !== 'default' ? out : undefined
}

function pickNumber(
  explicit: number | undefined,
  proj: number | undefined,
  glob: number | undefined,
): number | undefined {
  if (explicit !== undefined && explicit > 0) return explicit
  if (proj !== undefined && proj > 0) return proj
  if (glob !== undefined && glob > 0) return glob
  return undefined
}
