/**
 * Registers a palette + chord command per launch profile.
 *
 * Mounted once at the app root via <LaunchProfileCommands />. Re-runs
 * whenever the profile list changes so a fresh save instantly updates
 * the palette entries.
 */

import type { LaunchProfile } from '@shared/launch-profile'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useCommand } from '@/lib/commands'
import { pushLaunchToast } from './launch-toast'
import { runProfile } from './run-profile'
import { useLaunchProfiles } from './use-launch-profiles'

export function LaunchProfileCommands() {
  const { profiles } = useLaunchProfiles()
  return (
    <>
      {profiles.map(profile => (
        <ProfileCommand key={profile.id} profile={profile} />
      ))}
    </>
  )
}

function ProfileCommand({ profile }: { profile: LaunchProfile }) {
  useCommand(
    `launch-profile:${profile.id}`,
    () => {
      const sentinels = useConversationsStore.getState().sentinels
      void runProfile(
        profile,
        {},
        {
          sentinels,
          onToast: t => pushLaunchToast(t),
        },
      )
    },
    {
      label: `Launch :: ${profile.name}`,
      shortcut: profile.chord ? `mod+j ${profile.chord}` : undefined,
      group: 'Launch',
    },
  )
  return null
}
