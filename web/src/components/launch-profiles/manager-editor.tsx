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

  function patch(next: Partial<LaunchProfile>) {
    onChange({ ...profile, ...next, updatedAt: Date.now() })
  }

  function patchSpawn(next: Partial<LaunchProfile['spawn']>) {
    patch({ spawn: { ...profile.spawn, ...next } })
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5">
      <IdentitySection profile={profile} onPatch={patch} />
      <BehaviorSection profile={profile} onPatch={patch} />
      <BackendSection
        backend={backend}
        onChange={next => patchSpawn({ backend: next === 'claude' ? undefined : next })}
      />
      <LaunchFieldsSection
        value={launchFieldsFromProfile(profile)}
        onPatch={p => patchSpawn(spawnPatchFromLaunchFields(p))}
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
