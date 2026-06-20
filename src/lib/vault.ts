/**
 * Vault domain logic: the in-memory model and the encrypt/decrypt bridge to storage.
 * The decrypted VaultData and the CryptoKey only ever exist inside the service worker.
 */

import {
  decryptBytes,
  decryptJSON,
  deriveKey,
  deriveKeyFromEntropy,
  encryptBytes,
  encryptJSON,
  fromBase64,
  generateVaultKey,
  importVaultKey,
  PBKDF2_ITERATIONS,
  randomSalt,
  toBase64,
} from './crypto'
import { generateMnemonic, mnemonicToEntropy } from './bip39'
import { rankMatches } from './urlmatch'
import {
  readStoredVault,
  writeStoredVault,
  type KeyWrap,
  type StoredVault,
  type StoredVaultV1,
  type StoredVaultV2,
} from './storage'

export interface VaultEntry {
  id: string
  title: string
  url: string
  username: string
  password: string
  notes: string
  /** Optional TOTP/2FA shared secret (base32). Rides the same AES-GCM envelope. */
  totp?: string
  createdAt: number
  updatedAt: number
}

export interface VaultData {
  entries: VaultEntry[]
}

/**
 * Create a brand-new empty vault protected by `masterPassword`.
 *
 * Mints a random vault key, encrypts the (empty) data under it, and stores the
 * vault key wrapped under a password-derived key. Returns the non-extractable
 * vault key for the session.
 */
export async function createVault(
  masterPassword: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const vaultKeyBytes = generateVaultKey()
  const vaultKey = await importVaultKey(vaultKeyBytes)
  const wrap = await buildWrap('password', vaultKeyBytes, masterPassword, iterations)
  const payload = await encryptJSON(vaultKey, { entries: [] } as VaultData)
  await writeStoredVault({ version: 2, keyWraps: [wrap], payload })
  return vaultKey
}

/**
 * Unlock the vault with a secret, returning the vault key + decrypted data.
 * Tries each key wrap until one accepts the secret; throws if none do (wrong
 * password — AES-GCM auth failure, no separate password check). Transparently
 * migrates a legacy v1 vault to the wrapping format on first successful unlock.
 */
export async function unlockVault(
  masterPassword: string,
): Promise<{ key: CryptoKey; data: VaultData }> {
  const stored = await requireStored()
  if (stored.version === 1) return migrateAndUnlock(stored, masterPassword)

  const bytes = await unwrapVaultKeyBytes(stored, masterPassword)
  const vaultKey = await importVaultKey(bytes)
  const data = await decryptJSON<VaultData>(vaultKey, stored.payload)
  return { key: vaultKey, data }
}

/**
 * Add another unlock method over the *same* vault key. Re-derives the vault key
 * from `currentSecret`, wraps it under `newSecret`, and appends the wrap. This
 * is the additive path BIP39 recovery (v0.3) and biometric unlock (v0.4) ride on
 * — no vault re-encryption, just one more wrap.
 */
export async function addKeyWrap(
  currentSecret: string,
  newSecret: string,
  method: KeyWrap['method'] = 'password',
  iterations: number = PBKDF2_ITERATIONS,
): Promise<void> {
  const stored = await requireStored()
  if (stored.version !== 2) throw new Error('Vault must be migrated before adding key wraps')
  const vaultKeyBytes = await unwrapVaultKeyBytes(stored, currentSecret)
  const wrap = await buildWrap(method, vaultKeyBytes, newSecret, iterations)
  await writeStoredVault({ ...stored, keyWraps: [...stored.keyWraps, wrap] })
}

/**
 * Generate a fresh BIP39 recovery phrase and (re)wrap the vault key under it.
 * Replaces any existing recovery wrap so onboarding "Regenerate" is idempotent —
 * the old phrase stops working the moment a new one is minted. Returns the phrase
 * exactly once, for the user to write down; it is never stored in plaintext.
 */
export async function setupRecoveryPhrase(currentSecret: string): Promise<string> {
  const stored = await requireStored()
  if (stored.version !== 2) throw new Error('Vault must be migrated before adding a recovery phrase')
  const vaultKeyBytes = await unwrapVaultKeyBytes(stored, currentSecret)
  const phrase = await generateMnemonic()
  const wrap = await buildWrap('recovery', vaultKeyBytes, phrase, 0)
  const keyWraps = [...stored.keyWraps.filter((w) => w.method !== 'recovery'), wrap]
  await writeStoredVault({ ...stored, keyWraps })
  return phrase
}

/** True if the stored vault has a recovery-phrase wrap. */
export async function hasRecoveryPhrase(): Promise<boolean> {
  const stored = await readStoredVault()
  return stored?.version === 2 && stored.keyWraps.some((w) => w.method === 'recovery')
}

/**
 * Wrap the vault key under a WebAuthn PRF output (HKDF), tagged `biometric`.
 * `prfOutput` is the high-entropy bytes the platform authenticator returns after a
 * biometric check — treated exactly like the recovery phrase's entropy. Replaces any
 * existing biometric wrap (one authenticator at a time). Purely additive: the vault
 * key and data are never touched, only a wrap is appended.
 */
export async function addBiometricWrap(
  currentSecret: string,
  prfOutput: Uint8Array,
  credentialId: string,
): Promise<void> {
  const stored = await requireStored()
  if (stored.version !== 2) throw new Error('Vault must be migrated before adding biometric unlock')
  const vaultKeyBytes = await unwrapVaultKeyBytes(stored, currentSecret)
  const salt = randomSalt()
  const wrappingKey = await deriveKeyFromEntropy(prfOutput, salt)
  const wrapped = await encryptBytes(wrappingKey, vaultKeyBytes)
  const wrap: KeyWrap = { method: 'biometric', salt: toBase64(salt), iterations: 0, wrapped, credentialId }
  const keyWraps = [...stored.keyWraps.filter((w) => w.method !== 'biometric'), wrap]
  await writeStoredVault({ ...stored, keyWraps })
}

/** Unlock via the biometric wrap using the PRF output from a WebAuthn assertion. */
export async function unlockWithBiometric(
  prfOutput: Uint8Array,
): Promise<{ key: CryptoKey; data: VaultData }> {
  const stored = await requireStored()
  if (stored.version !== 2) throw new Error('Vault is not in the wrapping format')
  const wrap = stored.keyWraps.find((w) => w.method === 'biometric')
  if (!wrap) throw new Error('Biometric unlock is not set up')
  const wrappingKey = await deriveKeyFromEntropy(prfOutput, fromBase64(wrap.salt))
  const bytes = await decryptBytes(wrappingKey, wrap.wrapped) // throws on wrong PRF (GCM auth)
  const vaultKey = await importVaultKey(bytes)
  const data = await decryptJSON<VaultData>(vaultKey, stored.payload)
  return { key: vaultKey, data }
}

/** The stored biometric credential id (base64url), or null if not set up. Safe to call while locked. */
export async function getBiometricCredentialId(): Promise<string | null> {
  const stored = await readStoredVault()
  if (stored?.version !== 2) return null
  return stored.keyWraps.find((w) => w.method === 'biometric')?.credentialId ?? null
}

/** Drop the biometric wrap (disable biometric unlock). Other unlock methods are untouched. */
export async function removeBiometricWrap(): Promise<void> {
  const stored = await requireStored()
  if (stored.version !== 2) return
  const keyWraps = stored.keyWraps.filter((w) => w.method !== 'biometric')
  await writeStoredVault({ ...stored, keyWraps })
}

/**
 * Replace the password wrap with one derived from `newMasterPassword`. `currentSecret`
 * may be the old master password OR the recovery phrase — so this backs both "change
 * master password" and "I recovered with my phrase, now set a new password." The vault
 * key (and therefore all data) is untouched; only the password wrap is rewritten.
 */
export async function changeMasterPassword(
  currentSecret: string,
  newMasterPassword: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<void> {
  const stored = await requireStored()
  if (stored.version !== 2) throw new Error('Vault must be migrated before changing the password')
  const vaultKeyBytes = await unwrapVaultKeyBytes(stored, currentSecret)
  const wrap = await buildWrap('password', vaultKeyBytes, newMasterPassword, iterations)
  const keyWraps = [...stored.keyWraps.filter((w) => w.method !== 'password'), wrap]
  await writeStoredVault({ ...stored, keyWraps })
}

export async function loadData(key: CryptoKey): Promise<VaultData> {
  const stored = await requireStored()
  return decryptJSON<VaultData>(key, stored.payload)
}

export async function saveData(key: CryptoKey, data: VaultData): Promise<void> {
  const stored = await requireStored()
  // Swap only the payload; preserve version + key wraps untouched.
  const payload = await encryptJSON(key, data)
  await writeStoredVault({ ...stored, payload } as StoredVault)
}

export function newEntry(partial: Omit<VaultEntry, 'id' | 'createdAt' | 'updatedAt'>): VaultEntry {
  const now = Date.now()
  return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...partial }
}

/**
 * Find entries whose stored URL matches a page hostname, best match first.
 * Matching is by registrable domain (eTLD+1) with exact-host preferred over
 * subdomain over sibling-subdomain — see `urlmatch.ts`. This is the v0.5 autofill
 * improvement: a saved `example.com` now also surfaces on `login.example.com`.
 */
export function matchEntries(data: VaultData, hostname: string): VaultEntry[] {
  return rankMatches(data.entries, hostname)
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

/**
 * Wrap raw vault-key bytes under a key derived from `secret`, tagged `method`.
 * Password/biometric secrets go through PBKDF2; a recovery phrase is decoded to
 * its BIP39 entropy and stretched with HKDF (`iterations` is unused for recovery).
 */
async function buildWrap(
  method: KeyWrap['method'],
  vaultKeyBytes: Uint8Array,
  secret: string,
  iterations: number,
): Promise<KeyWrap> {
  const salt = randomSalt()
  const wrappingKey = await deriveWrappingKey(method, secret, salt, iterations)
  const wrapped = await encryptBytes(wrappingKey, vaultKeyBytes)
  return { method, salt: toBase64(salt), iterations: method === 'recovery' ? 0 : iterations, wrapped }
}

/** Derive the wrapping key for a method: HKDF over BIP39 entropy for recovery, else PBKDF2. */
async function deriveWrappingKey(
  method: KeyWrap['method'],
  secret: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  if (method === 'recovery') {
    const entropy = await mnemonicToEntropy(secret) // throws if not a valid 12-word phrase
    return deriveKeyFromEntropy(entropy, salt)
  }
  return deriveKey(secret, salt, iterations)
}

/** Try each wrap with `secret`; return the unwrapped vault-key bytes or throw. */
async function unwrapVaultKeyBytes(stored: StoredVaultV2, secret: string): Promise<Uint8Array> {
  for (const wrap of stored.keyWraps) {
    try {
      const wrappingKey = await deriveWrappingKey(wrap.method, secret, fromBase64(wrap.salt), wrap.iterations)
      return await decryptBytes(wrappingKey, wrap.wrapped)
    } catch {
      // Wrong secret (or not a valid phrase for a recovery wrap) — try the next method.
    }
  }
  throw new Error('No key wrap matched the supplied secret')
}

/**
 * One-time upgrade of a legacy v1 vault. Proves the password by decrypting under
 * the old master-derived key, then re-keys to the wrapping format: a fresh random
 * vault key encrypts the data and is wrapped under the same password. Non-destructive
 * — only writes the v2 vault after the new payload is successfully produced.
 */
async function migrateAndUnlock(
  stored: StoredVaultV1,
  masterPassword: string,
): Promise<{ key: CryptoKey; data: VaultData }> {
  const oldKey = await deriveKey(masterPassword, fromBase64(stored.salt), stored.iterations)
  const data = await decryptJSON<VaultData>(oldKey, stored.payload) // throws on wrong password

  const vaultKeyBytes = generateVaultKey()
  const vaultKey = await importVaultKey(vaultKeyBytes)
  const wrap = await buildWrap('password', vaultKeyBytes, masterPassword, stored.iterations)
  const payload = await encryptJSON(vaultKey, data)
  await writeStoredVault({ version: 2, keyWraps: [wrap], payload })
  return { key: vaultKey, data }
}

async function requireStored(): Promise<StoredVault> {
  const stored = await readStoredVault()
  if (!stored) throw new Error('No vault exists')
  return stored
}
