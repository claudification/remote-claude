/**
 * Minimal mock of bun:sqlite for vitest (Node runtime).
 * Only enough to satisfy module-level imports in SQLite-backed modules.
 * Tests that actually need SQLite should run under bun test directly.
 */

class Database {
  query(_sql: string) {
    return {
      all: () => [],
      get: () => undefined,
      run: () => {},
    }
  }
  exec(_sql: string) {}
  close() {}
}

export type Statement = ReturnType<Database['query']>
