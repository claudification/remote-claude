# Data Stores

## Project Registry (SQLite)

Stable integer IDs for projects. The authoritative source of project identity --
all other stores reference `projects.id` instead of repeating CWD strings.

**Storage:** `{cacheDir}/projects.db` (separate from analytics/cost -- this is
authoritative config, not disposable time-series data)

**Table:** `projects` (id INTEGER PK, cwd TEXT UNIQUE, scope TEXT UNIQUE, slug TEXT, label TEXT)

**Scope URI scheme** (future-facing):
```
{provider}://{address}#{session}
claude://my-machine/Users/jonas/projects/remote-claude#a1b2c3d4
claude:///Users/jonas/projects/remote-claude          (local, no host)
fabric://pipeline/data-etl-nightly
agent://openai/asst_abc123
```

**API:**
- `GET /api/projects` -- list all projects (admin only)

**Usage:** `getOrCreateProject(cwd, label?)` returns `Project` with integer `.id`.
Hot path uses in-memory cache (cwd -> Project). Cache miss falls through to DB.

Files: `project-store.ts`

## Analytics (SQLite)

Per-turn tool-use analytics. Task classification, one-shot success rate tracking,
retry cycle detection. Non-critical -- errors are logged and swallowed.

**Storage:** `{cacheDir}/analytics.db`

**Tables:**
- `turns` -- per-turn (timestamp, session_id, cwd, project_id INTEGER, model,
  tool_sequence, task_category, retry_count, one_shot, had_error, prompt_snippet)
- `tool_uses` -- per-tool-call (timestamp, session_id, tool_name)

**Task categories:** coding, debugging, refactoring, testing, exploration, git,
build, conversation, delegation, unknown. Classified deterministically from tool
use patterns + user prompt keywords.

**One-shot detection:** Counts edit-bash-edit retry cycles. `one_shot = 1` when
edits present, zero retries, and no error.

**Pipeline:** Hook events queue in memory per-session. On `Stop`/`StopFailure`,
the turn is classified and pushed to a batch queue. Flushed every 5s or 50 records.

**90-day retention.** Daily cleanup.

**API** (admin auth required):
- `GET /api/analytics/summary?period=7d&project=remote-claude`
- `GET /api/analytics/timeseries?period=7d&granularity=hour&project=remote-claude`
- `GET /api/analytics/models?period=7d&project=remote-claude`

All endpoints accept `?project=` (slug or integer ID) for per-project filtering.

**Mass import:** `bun scripts/import-analytics.ts` parses historical JSONL
transcripts from `~/.claude/projects/`. Idempotent (skips already-imported sessions).

Files: `analytics-store.ts`, `scripts/import-analytics.ts`

## Cost Reporting (SQLite)

Per-turn cost and token storage. Lives in the unified StoreDriver (not a
separate DB file as of Phase 4). `bun:sqlite` WAL mode. 30-day retention.

**Storage:** `{cacheDir}/store.db` (tables `turns` + `hourly_stats` alongside
the rest of the unified schema)

**Tables:**
- `turns` -- per-turn (timestamp, session, project_uri, account, model, tokens, cost, exact_cost)
- `hourly_stats` -- rollups by (hour, account, model, project_uri)

**Recording:**
- Headless: exact cost from `turn_cost` WS (`total_cost_usd`)
- PTY: estimated from tokens + LiteLLM pricing on `Stop` hook
- Both use `store.costs.recordTurnFromCumulatives()` (per-session snapshots,
  computes deltas)

**API** (admin auth required):
- `GET /api/stats/turns?from=&to=&account=&model=&project=&limit=&offset=`
- `GET /api/stats/hourly?from=&to=&groupBy=hour|day`
- `GET /api/stats/summary?period=24h|7d|30d`

`turn_recorded` WS broadcast after each insert.

**Migration from legacy `cost-data.db`:** `broker-cli migrate` absorbs any
pre-existing `cost-data.db` turns into the unified `store.db`. Idempotent:
re-running while the unified turns table is non-empty is a no-op with a
warning.

**Retention:** A 30-day prune runs daily from the broker's startup timer
(`index.ts`) via `store.costs.pruneOlderThan(cutoff)`.

**bun:sqlite gotcha:** `$name` in SQL -> key WITHOUT `$` in JS:
`db.prepare('WHERE x < $cutoff').run({ cutoff: 42 })`

Files: `store/sqlite/costs.ts`, `store/memory/driver.ts` (for tests),
`handlers/transcript.ts`, `session-store.ts`, `routes/stats.ts`, `store/migrate.ts`

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

sentinel polls `api.anthropic.com/api/oauth/usage` every 10 minutes using
OAuth token from macOS Keychain or `~/.claude/.credentials.json`. Only utilization
percentages forwarded -- credentials never leave host.

Dashboard: 5h/7d utilization bars in header. Per-model on desktop.
Green < 50%, amber < 75%, orange < 90%, red >= 90%.

Files: `src/sentinel/index.ts`, `handlers/sentinel.ts`, `usage-bar.tsx`

## Context Window Detection

`contextWindowSize()` resolves from LiteLLM DB (fetched by concentrator, served
via `GET /api/models`). Hardcoded fallback when DB not loaded.
