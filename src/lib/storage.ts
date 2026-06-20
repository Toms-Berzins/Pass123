/** Thin wrapper over chrome.storage.local — only ever holds ciphertext + KDF params. */

import type { EncryptedBlob } from './crypto'

const VAULT_KEY = 'pass123.vault'

/**
 * One way to unlock the vault. Each wrap stores the single random vault key,
 * AES-GCM-encrypted under a key derived from this method's secret. Multiple
 * wraps over the same vault key let password / recovery-phrase / biometric all
 * unlock the same data — adding a method just appends a wrap, never re-encrypts
 * the vault. `method` is `'password'` today; `'recovery'`/`'biometric'` slot in
 * identically (recovery derives its wrapping key via HKDF instead of PBKDF2).
 */
export interface KeyWrap {
  method: 'password' | 'recovery' | 'biometric'
  /** base64 KDF salt for this method (HKDF salt for recovery/biometric) */
  salt: string
  iterations: number
  /** the vault key, AES-GCM-encrypted under this method's derived wrapping key */
  wrapped: EncryptedBlob
  /** biometric only: WebAuthn credential id (base64url) to pass to navigator.credentials.get */
  credentialId?: string
}

/** Legacy format (v0.2): the master-derived key encrypts the payload directly. */
export interface StoredVaultV1 {
  version: 1
  /** base64 PBKDF2 salt */
  salt: string
  iterations: number
  /** AES-GCM encrypted VaultData */
  payload: EncryptedBlob
}

/** Key-wrapping format (v0.3): a random vault key encrypts the payload; wraps unlock it. */
export interface StoredVaultV2 {
  version: 2
  keyWraps: KeyWrap[]
  /** VaultData AES-GCM-encrypted under the vault key */
  payload: EncryptedBlob
}

export type StoredVault = StoredVaultV1 | StoredVaultV2

export async function readStoredVault(): Promise<StoredVault | null> {
  const result = await chrome.storage.local.get(VAULT_KEY)
  return (result[VAULT_KEY] as StoredVault | undefined) ?? null
}

export async function writeStoredVault(vault: StoredVault): Promise<void> {
  await chrome.storage.local.set({ [VAULT_KEY]: vault })
}

export async function vaultExists(): Promise<boolean> {
  return (await readStoredVault()) !== null
}

export async function clearVault(): Promise<void> {
  await chrome.storage.local.remove(VAULT_KEY)
}
