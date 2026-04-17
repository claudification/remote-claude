# Refactor master plan

Living document. Aggregates status across every refactor initiative touching this repo --
mega-file splits, shared-primitive extraction, architectural moves, naming cleanup.

**Last updated:** 2026-04-17 (branch `refactor/mega-file-splits`, PR #46, 18 commits)

## Currently in flight

### PR #46 -- `refactor/mega-file-splits` (draft, ready for smoke test)

- **Execution log:** [.claude/docs/plan-mega-file-splits.md](./.claude/docs/plan-mega-file-splits.md)
- **Duplication / reuse backlog:** [.claude/docs/duplication-candidates.md](./.claude/docs/duplication-candidates.md) (has both pre-split targets AND the deferred /simplify review findings)
- **Built + deployed locally:** concentrator Docker rebuilt + restarted 2026-04-17 (port 9999 healthy)

**Shipped in this PR (17 commits, 303/304 tests green):**

- `src/concentrator/routes.ts` 1964 -> 331 (-83%) + 7 route modules under `routes/`
- `web/src/components/session-list.tsx` 2097 -> 484 + 4 sub-components under `session-list/`
- `web/src/components/session-detail.tsx` 1841 -> 492 + 4 components under `session-detail/`
- `web/src/components/settings-page.tsx` 1380 -> 885 + sections under `settings/` + `lib/color-utils.ts`
- `src/concentrator/session-store.ts` 3495 -> 3108 + `parsers.ts`, `terminal-registry.ts`, `channel-registry.ts` (3 of 6 planned modules -- phase 2 deferred)
- Behavioral test safety net: 36 black-box tests in `src/concentrator/__tests__/session-store.test.ts`
- `SessionBanner` + `BannerButton` + `BannerStack` primitives (`ui/session-banner.tsx`), 5 banners migrated (`AskQuestionCard` joined on commit `7a5c917`)
- `TabButton` extracted in `session-tabs.tsx` (8x duplication collapsed)
- `filterSessionOrderTree` dedup in `routes/api.ts`
- MCP tool registry: schemas + handlers colocated in a single map inside `initMcpChannel`
- `/simplify` 3-agent review + 5 safe fixes applied (commit `a938cec`)
- `cwd-group` 5 session passes collapsed to one `partitionSessions` (commit `3f4aa49`)
- `SessionItemContent` per-render SessionStart scan dropped -- use `session.model` (commit `83a4ce7`)
- `SessionItemContent` split into `SessionItemFull` + `SessionItemCompact` (commit `4bc7b61`); boolean `compact` prop retired
- Skipped flaky `transcript-watcher > handles multiple rapid appends` test
- Docs: README tree + `data-stores.md` updated

### /simplify review findings -- 4 of 11 landed, 7 still deferred

Ran `/simplify` after the extractions. 3 parallel review agents (reuse, quality, efficiency)
surfaced 18 findings; 5 safe mechanical ones fixed inline (`formatTime` adoption,
`relativize` hoist, `EMPTY_SUBSCRIBER_SET` constant, `childCount` conditional, JSDoc cleanup).

Of the 11 deferred items, **4 landed in this PR** (`cwd-group` partition, `SessionItemContent`
SessionStart scan drop, `SessionItemContent` compact-prop split, `AskQuestionCard` ->
`SessionBanner` migration). The remaining **7 are still persisted in
`.claude/docs/duplication-candidates.md`** under "Deferred from /simplify review
(2026-04-17)". Examples of what's still open:

- `SessionTabs` 9-prop interface, 6 booleans -- collapse into permissions object
- Zustand selector filter pushdown (risky without stable-reference design)
- `session-item.tsx` `Date.now()` inside `.filter()` predicate (hoist to `const now`)
- `ChannelRegistry.migrateChannels` hardcodes channel list (derive from type)
- `session-header.tsx` raw path split vs `lastPathSegments`
- `formatAge` duplication: `session-links-section` vs shared helper
- `AskQuestionCard` inline type shape (should import canonical)

## Status: refactor board tasks

Project board tasks under `.rclaude/project/`. Status reflects post-PR #46 state.

| Task | Status | Notes |
|------|--------|-------|
| `refactor-routes` | DONE | 7 route modules, composition root at 331 lines |
| `refactor-session-list` | DONE | 4 sub-components |
| `refactor-session-detail` | DONE | 4 focused components |
| `refactor-settings-page` | DONE | 4 sections + color-utils |
| `refactor-session-store` | PARTIAL | Phase 1 done (3 modules + tests). Phase 2 (transcript cache, addEvent, persistence) deferred |
| `refactor-mcp-channel` | PARTIAL | Tool registry collapsed the schema/handler duplication. Per-tool file extraction still open |
| `refactor-transcript-components` | OPEN | `tool-line.tsx` + `group-view.tsx` split -- next recommended item |
| `refactor-agent-index` | OPEN | 1309 lines, 6 domains |
| `refactor-markdown-input` | OPEN | 1085 lines, 5 concerns |
| `refactor-project-settings-editor` | OPEN | 1049 lines, icon picker + permission matrix |
| `refactor-app-tsx` | OPEN | 788 lines, extract hooks |
| `refactor-use-sessions` | OPEN | RISKY (Zustand selector stability) -- defer unless forced |
| `investigate-breaking-use-websocket` | OPEN | RISKY -- same reason |
| `refactor-arrow-const-handlers` | OPEN | Project-wide style sweep, mechanical |
| `code-hygene-...internalId` | OPEN | Pure rename `internalId` -> `wrapperId` wrapper-side |

Master task umbrella: `.rclaude/project/inbox/master-refactor-codebase-simplification.md` (the original pre-execution plan; now partly outdated -- use this doc as the current source of truth).

## Deferred / scoped for future PRs

### Session-store phase 2

Extract the 3 remaining big chunks, one per PR with new tests per extraction:

1. **Transcript cache** (~500 lines) -- `addTranscriptEntries`, ring buffer, OSC-52 processing, subagent variants. Needs a typed context object (8+ shared state refs).
2. **`addEvent`** (~470 lines) -- riskiest. 20+ decision branches touching session state + cost + broadcast + transcript cache. Each branch gets a test case first.
3. **Persistence** (~280 lines) -- `saveState` / `loadStateSync` / `flushTranscripts`. Lower value but self-contained.

### Per-handler permission middleware

40 call sites across `routes/*` today each start with:

```ts
if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
```

Target: replace with Hono route-level middleware (`adminOnly()`, `requirePermission('spawn', '*')`).
Biggest LOC win remaining (~80 lines) + defence-in-depth (can't accidentally omit).
**Prereq:** integration tests for each permission scope so auth regressions can't slip through.

### Tool-renderers migration completion

`web/src/components/transcript/tool-line.tsx` still has 20+ inline per-tool renderers.
`tool-renderers.tsx` partially migrated. Completing it = ~400 LOC win, same pattern as the MCP
registry refactor (registry map by tool name). Low risk, high visibility.

### Per-tool MCP files

Now that tools live in a registry inside `initMcpChannel`, each could move to `src/wrapper/mcp-tools/{name}.ts`
exporting a `ToolDef`. Needs a `ToolContext` type that bundles callbacks + dialog state.
Marginal win -- only worth it if `mcp-channel.ts` grows further.

## Related plan docs

Not all of these are strictly refactors, but they touch architecture and have overlap with
the refactor agenda. All live under `.claude/docs/` (mostly gitignored, reference-only).

| Plan | Status | Relation |
|------|--------|----------|
| `plan-mega-file-splits.md` | IN FLIGHT (this PR) | Current execution log |
| `plan-permission-gating.md` | PROPOSAL | Pairs with permission middleware refactor |
| `plan-sqlite-storage.md` | PROPOSAL | Storage layer redesign (see `sqlite-storage-architecture` board task) |
| `plan-agnostic-protocol.md` | PROPOSAL | Protocol-agnostic architecture -- large, future |
| `plan-docker-isolation.md` | PROPOSAL | Session sandboxing -- orthogonal to refactor but touches wrapper/agent |
| `plan-multi-tenant.md` | PROPOSAL | Multi-tenant -- depends on permission redesign |
| `plan-multi-host-agent.md` | PROPOSAL | Agent layering |
| `plan-multi-sentinel.md` | PROPOSAL | Sentinel architecture |
| `plan-managed-workers.md` | PROPOSAL | Managed worker sessions |
| `plan-headless-backend.md` | SHIPPED (reference) | Historical context for the PTY/headless split |
| `plan-notes-tasks.md` | SHIPPED | Project board (`.rclaude/project/`) is this plan's output |
| `plan-explorer-tool.md` | SHIPPED | Dialog MCP tool |
| `plan-share-session.md` | SHIPPED | Session sharing |
| `plan-launch-jobs.md` / `plan-launch-monitor.md` | SHIPPED | Launch progress streaming |
| `plan-rename-to-project.md` | REFERENCE | Naming migration history |

## Guiding principles (applies to every refactor PR)

- **Files > ~200 lines are a code smell. Components > ~150 are a hard no.** (from `.claude/CLAUDE.md`)
- **No behavior changes in structural refactors.** Tests must pass before AND after.
- **Zero tolerance for errors.** `bun run typecheck` + `bunx biome check .` must be clean before commit.
- **Extract before duplicate.** Grep for existing builders before writing new code.
- **Zustand selector stability matters.** Never inline `|| []` -- use module-level constants. React #185 is real.
- **Permission checks first.** Every endpoint gates BEFORE data access. Data filtering is server-side only.
- **Commit early, push often.** Stashes are where work goes to die.

## Meta: where to find what

- **This doc** -- aggregated status, cross-refs, "what's next"
- **`.claude/docs/plan-mega-file-splits.md`** -- detailed execution log of the current/recent PR
- **`.claude/docs/duplication-candidates.md`** -- reuse targets discovered while splitting (agenda for reuse passes)
- **`.rclaude/project/open/refactor-*.md`** -- board tasks for each individual refactor initiative
- **`.rclaude/project/inbox/master-refactor-codebase-simplification.md`** -- original pre-execution plan (partly outdated; use this doc instead)
- **`README.md`** -- project structure tree (authoritative source-of-truth for directory layout)
