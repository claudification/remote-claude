# Refactor Backlog

From project-wide `/simplify` review (2026-03-12). Three parallel Opus agents
scanned all four components (wrapper, concentrator, agent, web dashboard).

## Completed

- [x] **BUG: Previous session ID logged wrong value** - `src/wrapper/index.ts` (f86112b)
- [x] **PERF: PASSIVE_HOOKS Set allocated per event** - `src/concentrator/session-store.ts` (f86112b)
- [x] **PERF: getTerminalViewers allocates Set per call** - `src/concentrator/session-store.ts` (f86112b)
- [x] **MEMORY: Unbounded session.events array** - capped at 1000 (f86112b)
- [x] **REUSE: Duplicated text extraction in scanForBgTasks** - extracted `extractEntryText()` (f86112b)
- [x] **REUSE: formatModel() not used in command palette** - was hand-inlined (f86112b)
- [x] **PERF: Unnecessary message.toString() on Bun WS** - already a string (f86112b)
- [x] **PERF: Double HTTP fetch on session click** - app.tsx useEffect already handles it (f86112b)
- [x] **PERF: Overly broad Zustand selectors** - narrowed to selected session only (f86112b)
- [x] **BUG: Infinite re-render from unstable Zustand selector fallbacks** - stable module-level refs (a8e83fc)
- [x] **REUSE: Triple type duplication (SessionSummary)** - moved to `src/shared/protocol.ts`, `@shared/*` path alias (6d45ecf)
- [x] **BUG: WrapperID leaking across sessions** - defense in depth in `setSessionSocket` (63a893a)
- [x] **BUG: RCLAUDE_WRAPPER_ID leaking across tmux sessions** - inline env var prefix (adf5771)
- [x] **PERF: Transcript-view full reprocess on every entry** - incremental grouping with `useIncrementalGroups` (cb841cc)
- [x] **Session eviction / TTL** - 1h TTL + 50 ended session cap, full cache cleanup (0b5fdcf)
- [x] **Broadcast debouncing** - coalesced `session_update` via `queueMicrotask` (91e0e47)
- [x] **Unbounded transcript cache** - already capped at 500/session, eviction prevents accumulation

## Open - Medium (worth doing)

- [ ] **Dead code in ws-server.ts**\
  `src/concentrator/ws-server.ts` has unused exports.\
  Fix: Audit and remove dead code, or inline into `index.ts` if only used there.

- [ ] **Duplicate symbol names across codebase**\
  Functions with the same name doing different things, or different functions doing the same thing.\
  Fix: Sweep all components, extract shared logic or rename for clarity.

## Open - Large (architectural)

- [ ] **N+1 broadcast pattern** (partially addressed)\
  Multiple hook events arriving in same tick each trigger full session summary serialization.\
  The `queueMicrotask` coalescing addresses the broadcast side. The `toSessionSummary()` call\
  still happens once per flush but no longer N times per tick. Further optimization possible\
  with dirty-flagging if profiling shows it's still hot.
