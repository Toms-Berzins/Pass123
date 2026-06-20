/**
 * User preferences. These are non-secret, so they live in chrome.storage.local
 * as plaintext — deliberately separate from the encrypted vault. Reading always
 * merges over defaults so older/partial stored objects stay forward-compatible.
 */

export interface Settings {
  /** Minutes of inactivity before the vault auto-locks (>= 1). */
  autoLockMinutes: number
  /** Offer to save/update credentials after a login submit. */
  captureEnabled: boolean
  /** Seconds before a copied secret is cleared from the clipboard (0 = never). */
  clipboardClearSeconds: number
}

export const DEFAULT_SETTINGS: Settings = {
  autoLockMinutes: 5,
  captureEnabled: true,
  clipboardClearSeconds: 30,
}

export const SETTINGS_STORAGE_KEY = 'pass123.settings'

function normalize(s: Settings): Settings {
  return {
    autoLockMinutes: clamp(Math.round(s.autoLockMinutes), 1, 240),
    captureEnabled: Boolean(s.captureEnabled),
    clipboardClearSeconds: clamp(Math.round(s.clipboardClearSeconds), 0, 600),
  }
}

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  const stored = result[SETTINGS_STORAGE_KEY] as Partial<Settings> | undefined
  return normalize({ ...DEFAULT_SETTINGS, ...stored })
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalize({ ...(await getSettings()), ...patch })
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next })
  return next
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi)
}
