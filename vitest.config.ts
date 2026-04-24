import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
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
