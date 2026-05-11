import type { LaunchProfile } from '@shared/launch-profile'

export interface FetchProfilesResponse {
  profiles: LaunchProfile[]
}

export interface SaveProfilesResponse {
  ok: boolean
  profiles?: LaunchProfile[]
  error?: string
}

export async function fetchLaunchProfiles(): Promise<LaunchProfile[]> {
  const res = await fetch('/api/launch-profiles')
  if (!res.ok) throw new Error(`GET /api/launch-profiles -> ${res.status}`)
  const data = (await res.json()) as FetchProfilesResponse
  return data.profiles
}

export async function putLaunchProfiles(profiles: LaunchProfile[]): Promise<SaveProfilesResponse> {
  const res = await fetch('/api/launch-profiles', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profiles }),
  })
  let data: SaveProfilesResponse | null = null
  try {
    data = (await res.json()) as SaveProfilesResponse
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    return { ok: false, error: data?.error ?? `PUT /api/launch-profiles -> ${res.status}` }
  }
  return data ?? { ok: true }
}
