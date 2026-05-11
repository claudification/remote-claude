/**
 * Reachability checks for a launch profile's pinned sentinel + project.
 *
 * Live state only -- no probes. Reads the sentinel registry already
 * delivered to the control panel via `sentinel_status` and the project
 * URI parser.
 */

import type { LaunchProfile } from '@shared/launch-profile'
import { parseProjectUri } from '@shared/project-uri'
import type { SentinelStatusInfo } from '@/hooks/use-conversations'

const DEFAULT_ALIAS = 'default'

export interface PinCheckOk {
  ok: true
  sentinel: string | undefined
  cwd: string | undefined
}

export interface PinCheckError {
  ok: false
  reason: string
}

export type PinCheckResult = PinCheckOk | PinCheckError

export function isSentinelReachable(name: string | undefined, sentinels: SentinelStatusInfo[]): boolean {
  if (!name || name === DEFAULT_ALIAS) {
    return sentinels.some(s => s.connected)
  }
  return sentinels.some(s => s.connected && (s.alias === name || s.sentinelId === name))
}

export function resolveProjectCwd(uri: string): string | null {
  try {
    return parseProjectUri(uri).path || null
  } catch {
    return null
  }
}

export function checkProfilePins(profile: LaunchProfile, sentinels: SentinelStatusInfo[]): PinCheckResult {
  if (profile.sentinel && !isSentinelReachable(profile.sentinel, sentinels)) {
    return { ok: false, reason: `Sentinel "${profile.sentinel}" is offline` }
  }
  let cwd: string | undefined
  if (profile.project) {
    const resolved = resolveProjectCwd(profile.project)
    if (!resolved) {
      return { ok: false, reason: `Pinned project URI "${profile.project}" is invalid` }
    }
    cwd = resolved
  }
  return { ok: true, sentinel: profile.sentinel, cwd }
}
