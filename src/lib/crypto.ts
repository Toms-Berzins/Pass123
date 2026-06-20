/**
 * Encryption primitives built on the Web Crypto API only — no third-party crypto.
 *
 * Design:
 *  - Key derivation: PBKDF2-SHA256 with a random per-vault salt and a high
 *    iteration count, producing a non-extractable AES-GCM CryptoKey.
 *  - Encryption: AES-256-GCM with a fresh random 12-byte IV per operation.
 *  - The master password is never stored. The derived key lives only in the
 *    service worker's memory while the vault is unlocked.
 */

export const PBKDF2_ITERATIONS = 310_000
const SALT_BYTES = 16
const IV_BYTES = 12

export interface EncryptedBlob {
  /** base64 AES-GCM IV (12 bytes) */
  iv: string
  /** base64 ciphertext (includes the GCM auth tag) */
  data: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES))
}

/** Derive a non-extractable AES-GCM key from the master password + salt. */
export async function deriveKey(
  masterPassword: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(masterPassword),
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  )
}

export async function encryptJSON(key: CryptoKey, value: unknown): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const plaintext = enc.encode(JSON.stringify(value))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext,
  )
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) }
}

/** Decrypt a blob. Throws if the key is wrong or the data is tampered (GCM auth fail). */
export async function decryptJSON<T>(key: CryptoKey, blob: EncryptedBlob): Promise<T> {
  const iv = fromBase64(blob.iv)
  const ciphertext = fromBase64(blob.data)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  )
  return JSON.parse(dec.decode(plaintext)) as T
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
