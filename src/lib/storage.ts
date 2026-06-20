/** Thin wrapper over chrome.storage.local — only ever holds ciphertext + KDF params. */

import type { EncryptedBlob } from './crypto'

const VAULT_KEY = 'pass123.vault'

/** What lives on disk. The payload is encrypted; salt/iterations are needed to derive the key. */
export interface StoredVault {
  version: 1
  /** base64 PBKDF2 salt */
  salt: string
  iterations: number
  /** AES-GCM encrypted VaultData */
  payload: EncryptedBlob
}

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
