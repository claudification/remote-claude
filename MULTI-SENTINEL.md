# Multi-Sentinel Architecture

Design doc for supporting multiple sentinel instances (one per host/machine).

## Current Architecture (Single Sentinel)

- Sentinel connects via WS with `RCLAUDE_SECRET` as query param
- Sends `{ type: 'sentinel_identify', machineId, hostname }`
- Broker stores it as a single `let sentinelSocket` variable
- Second sentinel gets `sentinel_reject` + close(4409), exits immediately
- Dashboard gets `{ type: 'sentinel_status', connected: boolean }` -- single bool
- Revive/spawn sends to `sessionStore.getSentinel()` -- no routing needed

## Sentinel Onboarding

Sentinels are invited -- similar to how users get invite codes for passkey
registration. The broker operator creates a named sentinel slot, which
generates a sentinel-specific key. The sentinel process must present this
key to connect.

### Creating a sentinel

```bash
concentrator-cli create-sentinel --name studio
```

Output:

```
Sentinel created: studio
Key: snt_a1b2c3d4e5f6...

Give this key to the host operator. It is shown once and cannot be recovered.
The sentinel must set RCLAUDE_SENTINEL_KEY=snt_... (or pass --key).
```

**Name rules:**
- Slug format: lowercase, alphanumeric, hyphens (`studio`, `build-server`, `ci-runner-1`)
- Unique across the broker
- Immutable after creation (delete + recreate to rename)
- Becomes the authority in the project URI: `claude://studio/Users/jonas/projects/foo`

**Key rules:**
- Prefixed `snt_` for easy identification in env vars / logs
- HMAC-SHA256 signed by the broker's signing secret (same one used for session cookies)
- Encodes the sentinel name so the broker can derive identity from the key alone
- Shown once at creation, then stored hashed -- not recoverable

### Managing sentinels

```bash
concentrator-cli list-sentinels
# NAME          STATUS      LAST SEEN           MACHINE ID
# studio        connected   2026-04-23 14:30    a1b2c3d4
# build-server  offline     2026-04-22 09:15    e5f6a7b8

concentrator-cli revoke-sentinel --name build-server
# Sentinel revoked: build-server
# Active connection (if any) will be terminated immediately.

concentrator-cli rotate-sentinel-key --name studio
# New key: snt_x9y8z7w6...
# Old key is now invalid. Update the host.
```

### Sentinel connection flow

```
sentinel                          broker
   |                                |
   |--- WS connect (/ws?key=snt_...) -->
   |                                |
   |                    validate key (HMAC verify)
   |                    extract sentinel name from key
   |                    check not revoked
   |                    register in sentinel map
   |                                |
   |<-- { type: 'ack', eventId: 'sentinel', name: 'studio' }
   |                                |
   |--- { type: 'sentinel_identify', machineId, hostname } -->
   |                                |
   |                    store metadata (machineId, hostname)
   |                    broadcast sentinel_status to dashboard
   |                                |
```

**Auth change:** Today sentinels share `RCLAUDE_SECRET` with wrappers. With
per-sentinel keys, the sentinel authenticates with `RCLAUDE_SENTINEL_KEY`
instead. `RCLAUDE_SECRET` remains for wrapper auth and API bearer tokens.

### Sentinel process changes

```bash
# New env var (replaces RCLAUDE_SECRET for sentinel auth)
RCLAUDE_SENTINEL_KEY=snt_a1b2c3d4e5f6...

# Or CLI flag
sentinel --key snt_a1b2c3d4e5f6...

# Backward compat: if RCLAUDE_SENTINEL_KEY is not set, fall back to
# RCLAUDE_SECRET (single-sentinel legacy mode). Log a deprecation warning.
```

The sentinel no longer needs `--hostname` -- the broker derives the name from
the key. The sentinel still sends `hostname` and `machineId` in
`sentinel_identify` as metadata (for display in dashboard), but these are
informational, not identity.

## Protocol Changes

### Wire types

```typescript
interface SentinelIdentify {
  type: 'sentinel_identify'
  hostname: string
  machineId?: string
}

interface SentinelStatus {
  type: 'sentinel_status'
  sentinels: Array<{
    name: string
    hostname?: string
    machineId?: string
    connected: boolean
    lastSeen?: number
  }>
}

interface ReviveSession {
  type: 'revive'
  sessionId: string
  cwd: string
  wrapperId: string
  targetSentinel?: string  // route to specific sentinel (default: origin)
}

interface SpawnSession {
  type: 'spawn'
  requestId: string
  cwd: string
  wrapperId: string
  targetSentinel?: string  // route to specific sentinel (default: any)
}
```

### Session store

- Replace `let sentinelSocket` with `Map<string, { ws, meta }>`
- `setSentinel(name, ws, meta)` -- allow multiple, keyed by name
- `getSentinel(name?)` -- look up by name, or return first if unspecified
- `removeSentinel(ws)` -- find by socket reference, remove from map
- `hasSentinel(name?)` -- check specific or any
- `listSentinels()` -- return all with connection status

### Session routing

Sessions record which sentinel they originated from:

```typescript
interface Session {
  // ... existing fields
  originSentinel?: string  // name of the sentinel that spawned this session
}
```

- Revive routes to `session.originSentinel` (fail if offline, offer alternatives)
- Spawn routes to user-selected sentinel (or any available if unspecified)
- Directory listing routes to the targeted sentinel

### Dashboard

- `sentinelConnected: boolean` -> `sentinels: Array<{ name, connected, hostname }>`
- Status indicator: show count + names instead of single dot
- Spawn dialog: sentinel picker when multiple are connected
- Revive: auto-selects origin sentinel, warns if offline
- Session detail: show which sentinel hosts this session

## Data Storage

Sentinel registry is stored in the broker's SQLite database:

```sql
CREATE TABLE sentinels (
  name TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,       -- bcrypt or argon2 hash of snt_... key
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen INTEGER,
  machine_id TEXT,
  hostname TEXT
);
```

## Migration Path

1. Add `sentinels` table + CLI commands (create/list/revoke/rotate)
2. Accept `key=snt_...` on WS connect alongside legacy `secret=...`
3. Change session-store from single socket to Map
4. Add `originSentinel` to Session, set on wrapper connect
5. Update `sentinel_status` to include sentinel list
6. Update dashboard for multi-sentinel display
7. Add `targetSentinel` to spawn/revive routing
8. Deprecate `RCLAUDE_SECRET` for sentinel auth (keep working for one release)

Steps 1-4 are backward compatible -- existing single-sentinel setups keep working.

## Open Questions

- **Key rotation UX:** Rotating a key requires updating the host. Should we
  support dual-key windows (old + new valid for N hours)?
- **Offline sentinel revival:** When a session's origin sentinel is offline, should
  we offer to spawn on a different sentinel? Or queue until it reconnects?
- **Sentinel-to-sentinel:** Do sentinels ever need to talk to each other?
  Probably not for v1. Inter-session messaging already routes through the broker.
- **Sentinel capabilities:** Should sentinels declare capabilities (e.g. "has GPU",
  "has Docker", "macOS only")? Useful for intelligent spawn routing but adds
  complexity. Defer to fabric Phase 8 (AgentHostMeta).
