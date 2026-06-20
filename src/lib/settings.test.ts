import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from './settings'

// Runs against the in-memory chrome.storage.local stub from test/setup.ts.

describe('settings', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('merges a partial patch over existing values', async () => {
    await saveSettings({ autoLockMinutes: 15 })
    const s = await saveSettings({ captureEnabled: false })
    expect(s.autoLockMinutes).toBe(15)
    expect(s.captureEnabled).toBe(false)
    expect(s.clipboardClearSeconds).toBe(DEFAULT_SETTINGS.clipboardClearSeconds)
  })

  it('persists across reads', async () => {
    await saveSettings({ clipboardClearSeconds: 0 })
    expect((await getSettings()).clipboardClearSeconds).toBe(0)
  })

  it('clamps and rounds out-of-range values', async () => {
    const s = await saveSettings({ autoLockMinutes: 9999, clipboardClearSeconds: -5 })
    expect(s.autoLockMinutes).toBe(240)
    expect(s.clipboardClearSeconds).toBe(0)
  })

  it('fills missing fields from defaults for forward-compatibility', async () => {
    // Simulate an older stored object missing newer keys.
    await chrome.storage.local.set({ 'pass123.settings': { autoLockMinutes: 3 } })
    const s = await getSettings()
    expect(s.autoLockMinutes).toBe(3)
    expect(s.captureEnabled).toBe(DEFAULT_SETTINGS.captureEnabled)
  })
})
