import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Mock bun:sqlite for tests that transitively import cost-store.ts
    // (runs in vitest/Node, not bun runtime)
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
