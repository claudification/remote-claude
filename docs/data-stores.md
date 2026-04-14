# Data Stores

## Cost Reporting (SQLite)

Per-turn cost and token storage. `bun:sqlite` WAL mode. 30-day retention.

**Storage:** `{cacheDir}/cost-data.db`

**Tables:**
- `turns` -- per-turn (timestamp, session, cwd, account, model, tokens, cost, exact_cost)
- `hourly_stats` -- rollups by (hour, account, model, cwd)

**Recording:**
- Headless: exact cost from `turn_cost` WS (`total_cost_usd`)
- PTY: estimated from tokens + LiteLLM pricing on `Stop` hook
- Both use `recordTurnFromCumulatives()` (per-session snapshots, computes deltas)

**API** (admin auth required):
- `GET /api/stats/turns?from=&to=&account=&model=&cwd=&limit=&offset=`
- `GET /api/stats/hourly?from=&to=&groupBy=hour|day`
- `GET /api/stats/summary?period=24h|7d|30d`

`turn_recorded` WS broadcast after each insert.

**bun:sqlite gotcha:** `$name` in SQL -> key WITHOUT `$` in JS:
`db.prepare('WHERE x < $cutoff').run({ cutoff: 42 })`

Files: `cost-store.ts`, `handlers/transcript.ts`, `session-store.ts`, `routes.ts`

## Model Pricing (LiteLLM)

Concentrator fetches `model_prices_and_context_window.json` from LiteLLM GitHub on
startup, caches to `{cacheDir}/litellm-pricing.json`, refreshes every 24h.
Only Claude models stored. Served via `GET /api/models`.

Dashboard: `contextWindowSize()` and `estimateCost()` with hardcoded fallback.
Files: `model-pricing.ts`, `web/src/lib/model-db.ts`, `web/src/lib/cost-utils.ts`

## Session Stats

`session.stats` accumulated from transcript entries and hook events:

- Tokens: totalInputTokens, totalOutputTokens, totalCacheCreation, totalCacheRead
- Activity: turnCount, toolCallCount, compactionCount
- Cost: totalCostUsd (exact for headless, undefined for PTY)
- Lines changed: linesAdded/linesRemoved (from Edit structuredPatch hunks, incremental only)
- API time: totalApiDurationMs (from system `turn_duration` entries)

## Plan Usage Tracking

rclaude-agent polls `api.anthropic.com/api/oauth/usage` every 10 minutes using
OAuth token from macOS Keychain or `~/.claude/.credentials.json`. Only utilization
percentages forwarded -- credentials never leave host.

Dashboard: 5h/7d utilization bars in header. Per-model on desktop.
Green < 50%, amber < 75%, orange < 90%, red >= 90%.

Files: `src/agent/index.ts`, `handlers/agent.ts`, `usage-bar.tsx`

## Context Window Detection

`contextWindowSize()` resolves from LiteLLM DB (fetched by concentrator, served
via `GET /api/models`). Hardcoded fallback when DB not loaded.
