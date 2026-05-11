import { describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { LaunchProfile } from '../../shared/launch-profile'
import { broadcastLaunchProfilesUpdated } from './broadcast'

interface FakeWs {
  data: { userName?: string }
  sent: string[]
  send(json: string): void
}

function fakeWs(userName?: string): FakeWs {
  const ws: FakeWs = {
    data: { userName },
    sent: [],
    send(json: string) {
      this.sent.push(json)
    },
  }
  return ws
}

const PROFILE: LaunchProfile = {
  id: 'lp_test',
  name: 'Test',
  spawn: {},
  createdAt: 0,
  updatedAt: 0,
}

describe('broadcastLaunchProfilesUpdated', () => {
  it('sends to subscribers owned by the target user', () => {
    const a = fakeWs('jonas')
    const subs = new Set<ServerWebSocket<unknown>>([a as unknown as ServerWebSocket<unknown>])
    broadcastLaunchProfilesUpdated(subs, 'jonas', [PROFILE])
    expect(a.sent.length).toBe(1)
    const msg = JSON.parse(a.sent[0]!) as { type: string; userName: string; launchProfiles: LaunchProfile[] }
    expect(msg.type).toBe('launch_profiles_updated')
    expect(msg.userName).toBe('jonas')
    expect(msg.launchProfiles[0]?.name).toBe('Test')
  })

  it('skips subscribers owned by a different user', () => {
    const jonas = fakeWs('jonas')
    const alice = fakeWs('alice')
    const subs = new Set<ServerWebSocket<unknown>>([
      jonas as unknown as ServerWebSocket<unknown>,
      alice as unknown as ServerWebSocket<unknown>,
    ])
    broadcastLaunchProfilesUpdated(subs, 'jonas', [PROFILE])
    expect(jonas.sent.length).toBe(1)
    expect(alice.sent.length).toBe(0)
  })

  it('skips unauthenticated sockets', () => {
    const anon = fakeWs()
    const subs = new Set<ServerWebSocket<unknown>>([anon as unknown as ServerWebSocket<unknown>])
    broadcastLaunchProfilesUpdated(subs, 'jonas', [])
    expect(anon.sent.length).toBe(0)
  })

  it('survives a dead socket', () => {
    const dead: FakeWs = {
      data: { userName: 'jonas' },
      sent: [],
      send() {
        throw new Error('dead')
      },
    }
    const live = fakeWs('jonas')
    const subs = new Set<ServerWebSocket<unknown>>([
      dead as unknown as ServerWebSocket<unknown>,
      live as unknown as ServerWebSocket<unknown>,
    ])
    expect(() => broadcastLaunchProfilesUpdated(subs, 'jonas', [PROFILE])).not.toThrow()
    expect(live.sent.length).toBe(1)
  })
})
