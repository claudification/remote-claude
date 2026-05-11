/**
 * Push the updated launch-profile list to every WS connection owned by
 * the same user. Other users' tabs ignore the message via the userName
 * field; client filters by current session's userName.
 */

import type { ServerWebSocket } from 'bun'
import type { LaunchProfile } from '../../shared/launch-profile'

interface WsLikeData {
  userName?: string
}

export function broadcastLaunchProfilesUpdated(
  subscribers: Iterable<ServerWebSocket<unknown>>,
  userName: string,
  launchProfiles: LaunchProfile[],
): void {
  const json = JSON.stringify({
    type: 'launch_profiles_updated',
    userName,
    launchProfiles,
  })
  for (const ws of subscribers) {
    if ((ws.data as WsLikeData)?.userName !== userName) continue
    try {
      ws.send(json)
    } catch {
      /* dead socket */
    }
  }
}
