import { defineConfig } from 'vitest/config'

// Standalone test config — deliberately omits the CRXJS plugin so tests run
// as plain ESM in Node (with global Web Crypto). Chrome APIs are stubbed per-test.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
})
