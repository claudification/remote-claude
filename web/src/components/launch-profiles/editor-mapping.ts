import type { LaunchProfile } from '@shared/launch-profile'
import type { LaunchFieldsValue } from '@/components/launch-config-fields'

export function launchFieldsFromProfile(p: LaunchProfile): LaunchFieldsValue {
  return {
    model: p.spawn.model ?? '',
    effort: p.spawn.effort ?? '',
    permissionMode: p.spawn.permissionMode ?? '',
    agent: p.spawn.agent ?? '',
    autocompactPct: p.spawn.autocompactPct ?? '',
    maxBudgetUsd: p.spawn.maxBudgetUsd != null ? String(p.spawn.maxBudgetUsd) : '',
  }
}

export function spawnPatchFromLaunchFields(patch: Partial<LaunchFieldsValue>): Partial<LaunchProfile['spawn']> {
  const out: Partial<LaunchProfile['spawn']> = {}
  if (patch.model !== undefined) out.model = patch.model || undefined
  if (patch.effort !== undefined) out.effort = (patch.effort || undefined) as LaunchProfile['spawn']['effort']
  if (patch.permissionMode !== undefined) {
    out.permissionMode = (patch.permissionMode || undefined) as LaunchProfile['spawn']['permissionMode']
  }
  if (patch.agent !== undefined) out.agent = patch.agent || undefined
  if (patch.autocompactPct !== undefined) {
    out.autocompactPct = patch.autocompactPct === '' ? undefined : Number(patch.autocompactPct)
  }
  if (patch.maxBudgetUsd !== undefined) {
    const n = Number(patch.maxBudgetUsd)
    out.maxBudgetUsd = Number.isFinite(n) && n > 0 ? n : undefined
  }
  return out
}
