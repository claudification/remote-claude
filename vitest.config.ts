import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      // Real-sqlite integration tests -- run via `bun test` (see test:sqlite script).
      // The bun:sqlite mock can't simulate full SQL behavior, so these would fail under vitest.
      'src/broker/store/__tests__/store-driver.test.ts',
      'src/broker/store/__tests__/transcript-search.test.ts',
      'src/broker/__tests__/backup-fts.test.ts',
      // Staging tests self-skip when STAGING_BROKER_URL is unset (describe.skip).
      // Do NOT exclude them here -- that blocks scripts/staging-test.sh from finding them.
    ],
    environment: 'node',
    // Mock bun:sqlite for tests that transitively import SQLite-backed modules
    // (runs in vitest/Node, not bun runtime). Bun-runtime tests use bun:test directly.
    alias: {
      'bun:sqlite': new URL('./src/__mocks__/bun-sqlite.ts', import.meta.url).pathname,
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
})
