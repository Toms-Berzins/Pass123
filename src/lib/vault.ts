/**
 * Vault domain logic: the in-memory model and the encrypt/decrypt bridge to storage.
 * The decrypted VaultData and the CryptoKey only ever exist inside the service worker.
 */

import {
  decryptJSON,
  deriveKey,
  encryptJSON,
  fromBase64,
  PBKDF2_ITERATIONS,
  randomSalt,
  toBase64,
} from './crypto'
import { readStoredVault, writeStoredVault, type StoredVault } from './storage'

export interface VaultEntry {
  id: string
  title: string
  url: string
  username: string
  password: string
  notes: string
  createdAt: number
  updatedAt: number
}

export interface VaultData {
  entries: VaultEntry[]
}

/** Create a brand-new empty vault protected by `masterPassword`. */
export async function createVault(masterPassword: string): Promise<CryptoKey> {
  const salt = randomSalt()
  const key = await deriveKey(masterPassword, salt)
  const data: VaultData = { entries: [] }
  await persist(key, salt, PBKDF2_ITERATIONS, data)
  return key
}

/** Derive the key from the password and verify it by decrypting. Throws on wrong password. */
export async function unlockVault(
  masterPassword: string,
): Promise<{ key: CryptoKey; data: VaultData }> {
  const stored = await requireStored()
  const salt = fromBase64(stored.salt)
  const key = await deriveKey(masterPassword, salt, stored.iterations)
  // Decrypt = verification. AES-GCM throws on a wrong key (bad auth tag).
  const data = await decryptJSON<VaultData>(key, stored.payload)
  return { key, data }
}

export async function loadData(key: CryptoKey): Promise<VaultData> {
  const stored = await requireStored()
  return decryptJSON<VaultData>(key, stored.payload)
}

export async function saveData(key: CryptoKey, data: VaultData): Promise<void> {
  const stored = await requireStored()
  await persist(key, fromBase64(stored.salt), stored.iterations, data)
}

export function newEntry(partial: Omit<VaultEntry, 'id' | 'createdAt' | 'updatedAt'>): VaultEntry {
  const now = Date.now()
  return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...partial }
}

/** Find entries whose stored URL matches a page hostname. */
export function matchEntries(data: VaultData, hostname: string): VaultEntry[] {
  const host = hostname.replace(/^www\./, '').toLowerCase()
  return data.entries.filter((e) => {
    if (!e.url) return false
    try {
      const u = new URL(e.url.includes('://') ? e.url : `https://${e.url}`)
      return u.hostname.replace(/^www\./, '').toLowerCase() === host
    } catch {
      return e.url.toLowerCase().includes(host)
    }
  })
}

export type CaptureAction =
  | { kind: 'none' }
  | { kind: 'save' }
  | { kind: 'update'; id: string; title: string }

/**
 * Decide what to do with credentials captured from a login form (pure logic):
 *  - nothing if either field is empty, or an identical entry already exists
 *  - update if the same username on this host is saved with a different password
 *  - save if this host/username combo is new
 */
export function captureDecision(
  data: VaultData,
  hostname: string,
  username: string,
  password: string,
): CaptureAction {
  if (!username || !password) return { kind: 'none' }
  const same = matchEntries(data, hostname).find(
    (e) => e.username.toLowerCase() === username.toLowerCase(),
  )
  if (!same) return { kind: 'save' }
  if (same.password === password) return { kind: 'none' }
  return { kind: 'update', id: same.id, title: same.title || same.url || hostname }
}

async function persist(
  key: CryptoKey,
  salt: Uint8Array,
  iterations: number,
  data: VaultData,
): Promise<void> {
  const payload = await encryptJSON(key, data)
  const vault: StoredVault = { version: 1, salt: toBase64(salt), iterations, payload }
  await writeStoredVault(vault)
}

async function requireStored(): Promise<StoredVault> {
  const stored = await readStoredVault()
  if (!stored) throw new Error('No vault exists')
  return stored
}
