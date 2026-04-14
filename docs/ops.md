# Operations

## Deploy (concentrator Docker)

Behind Caddy reverse proxy on Synology NAS.

```bash
docker compose build && docker compose up -d        # Build + deploy
docker compose build --no-cache && docker compose up -d  # Force rebuild
docker compose logs -f concentrator                  # Logs
```

**Env vars** (`.env` or shell):
- `RCLAUDE_SECRET` - shared secret for WS auth (required)
- `RP_ID` - WebAuthn relying party domain (default: localhost)
- `ORIGIN` - WebAuthn origin URL (default: http://localhost:9999)
- `CADDY_HOST` - Caddy hostname (optional)
- `PORT` - external port (default: 9999)

**Auth management:**
```bash
concentrator-cli invite create
concentrator-cli passkey list
```

**CLI auth:** `Authorization: Bearer $RCLAUDE_SECRET` header on all API endpoints.
`RCLAUDE_SECRET` sourced from `~/.secrets`.

**Frontend shortcut:** `web/dist/` volume-mounted. Frontend-only changes: just
`bun run build:web` -- no container rebuild.

## Logging

**All multi-step operations MUST log at each stage.**

| Component | Method | Destination |
|---|---|---|
| Wrapper | `debug()` | stderr (`RCLAUDE_DEBUG=1`) |
| Wrapper | `ctx.diag(tag, msg)` | WS -> concentrator diagLog -> Diag tab |
| Agent | `diag(tag, msg, data)` | WS -> concentrator + `.agent.log` |
| Concentrator | `console.log` / `ctx.log.info` | Docker stdout |
| Shell scripts | `echo >>` | `/tmp/concentrator-launch-log.log` |

**Ad-hoc spawn:** `[ad-hoc]` prefix at every step for easy grep.

## Diag Mnemonics

Paste `diag:{sessionId}` -> fetch and analyze:
```bash
curl -s https://CONCENTRATOR_HOST/sessions/{sessionId}/diag
```
Contains: metadata, capabilities, events, transcript, subagents, tasks, diagLog.

## Version Tracking

`scripts/gen-version.ts` bakes git hash + build time into `src/shared/version.ts`.
Sent in SessionMeta on connect.

**Min Bun version:** `src/shared/bun-version.ts`, currently `1.3.12`.

**`--compile --bytecode` is NOT safe** for cross-compiled binaries (macOS -> Linux Docker).
JSC bytecode is platform-specific.

## Changelog Maintenance

`CHANGELOG.md` in project root. Background haiku agent updates from `git log --since="7 days ago"`.
Grouped by date, categorized (Features/Fixes/Refactors). Keep last 90 days.

## Claude Code Upstream Tracking

Changelog: `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`\
CC Leaks: `https://www.ccleaks.com/`\
Use `/cc-changelog` skill to fetch and analyze for impact.

Watch for: hook changes, settings format, transcript format, bug fixes affecting
workarounds, new CLI flags.
