import { beforeEach, vi } from 'vitest'

/**
 * Minimal in-memory stub of `chrome.storage.local` so vault/storage code can run
 * under Node without a browser. Reset before every test for isolation.
 */
const store = new Map<string, unknown>()

const chromeStub = {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) store.set(k, v)
      }),
      remove: vi.fn(async (key: string) => {
        store.delete(key)
      }),
    },
  },
}

;(globalThis as unknown as { chrome: typeof chromeStub }).chrome = chromeStub

beforeEach(() => {
  store.clear()
  vi.clearAllMocks()
})
