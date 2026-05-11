import type { LaunchProfile } from '@shared/launch-profile'
import { backendSupportsAppendSystemPrompt } from '@shared/launch-profile'
import type { BackendKind } from '@/components/spawn-dialog/backend-select'
import { launchFieldsFromProfile, spawnPatchFromLaunchFields } from './editor-mapping'
import {
  AppendSystemPromptSection,
  BackendSection,
  BehaviorSection,
  HiddenAppendPromptNotice,
  IdentitySection,
  LaunchFieldsSection,
  PinningSection,
} from './editor-sections'

interface Props {
  profile: LaunchProfile
  onChange: (next: LaunchProfile) => void
}

export function ManagerEditor({ profile, onChange }: Props) {
  const backend = (profile.spawn.backend ?? 'claude') as BackendKind
  const showAppendSp = backendSupportsAppendSystemPrompt(backend)
  const hasIncompatibleFields = !showAppendSp ? false : hasBackendIncompatibleFields(profile, backend)

  function patch(next: Partial<LaunchProfile>) {
    onChange({ ...profile, ...next, updatedAt: Date.now() })
  }

  function patchSpawn(next: Partial<LaunchProfile['spawn']>) {
    patch({ spawn: { ...profile.spawn, ...next } })
  }

  function switchBackend(next: BackendKind) {
    const cleared: Partial<LaunchProfile['spawn']> = { backend: next === 'claude' ? undefined : next }
    if (!backendSupportsAppendSystemPrompt(next)) cleared.appendSystemPrompt = undefined
    if (next !== 'opencode') {
      cleared.openCodeModel = undefined
      cleared.toolPermission = undefined
    }
    patchSpawn(cleared)
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5">
      <IdentitySection profile={profile} onPatch={patch} />
      <BehaviorSection profile={profile} onPatch={patch} />
      <BackendSection backend={backend} onChange={switchBackend} hasIncompatibleFields={hasIncompatibleFields} />
      <LaunchFieldsSection
        value={launchFieldsFromProfile(profile)}
        onPatch={p => patchSpawn(spawnPatchFromLaunchFields(p))}
        show={{
          model: true,
          effort: true,
          permissionMode: true,
          agent: true,
          autocompactPct: true,
          maxBudgetUsd: true,
          headless: backend === 'claude',
          repl: backend === 'claude',
          bare: backend === 'claude',
          includePartialMessages: backend === 'claude',
        }}
      />
      {showAppendSp ? (
        <AppendSystemPromptSection
          value={profile.spawn.appendSystemPrompt ?? ''}
          onChange={text => patchSpawn({ appendSystemPrompt: text || undefined })}
        />
      ) : (
        <HiddenAppendPromptNotice backend={backend} hasValue={!!profile.spawn.appendSystemPrompt} />
      )}
      <PinningSection profile={profile} onPatch={patch} />
    </div>
  )
}

function hasBackendIncompatibleFields(profile: LaunchProfile, backend: BackendKind): boolean {
  if (backend === 'opencode') return false
  return !!(profile.spawn.appendSystemPrompt || profile.spawn.openCodeModel || profile.spawn.toolPermission)
}
