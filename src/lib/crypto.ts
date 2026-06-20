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
const VAULT_KEY_BYTES = 32 // 256-bit AES key

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

/** AES-GCM encrypt raw bytes with a fresh random IV. */
export async function encryptBytes(key: CryptoKey, bytes: Uint8Array): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    bytes as BufferSource,
  )
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) }
}

/** Decrypt raw bytes. Throws if the key is wrong or the data is tampered (GCM auth fail). */
export async function decryptBytes(key: CryptoKey, blob: EncryptedBlob): Promise<Uint8Array> {
  const iv = fromBase64(blob.iv)
  const ciphertext = fromBase64(blob.data)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  )
  return new Uint8Array(plaintext)
}

export async function encryptJSON(key: CryptoKey, value: unknown): Promise<EncryptedBlob> {
  return encryptBytes(key, enc.encode(JSON.stringify(value)))
}

/** Decrypt a blob. Throws if the key is wrong or the data is tampered (GCM auth fail). */
export async function decryptJSON<T>(key: CryptoKey, blob: EncryptedBlob): Promise<T> {
  return JSON.parse(dec.decode(await decryptBytes(key, blob))) as T
}

/**
 * Generate a fresh random 256-bit vault key as raw bytes.
 *
 * In the key-wrapping model this is the single key that encrypts all vault data.
 * The raw bytes only exist transiently — long enough to wrap them under an unlock
 * method (password / recovery / biometric). For data operations they are imported
 * as a non-extractable CryptoKey via {@link importVaultKey}.
 */
export function generateVaultKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(VAULT_KEY_BYTES))
}

/**
 * Derive a non-extractable AES-GCM *wrapping* key from raw entropy via HKDF-SHA256.
 *
 * Used by the recovery-phrase unlock: the BIP39 phrase's 128-bit entropy is the
 * secret (already high-entropy, so HKDF — not a slow PBKDF — is the right KDF).
 * The resulting key only ever wraps/unwraps the vault key, never vault data.
 */
export async function deriveKeyFromEntropy(
  entropy: Uint8Array,
  salt: Uint8Array,
  info = 'pass123-recovery',
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', entropy as BufferSource, 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode(info) },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  )
}

/** Import raw vault-key bytes as a non-extractable AES-GCM CryptoKey for data ops. */
export function importVaultKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    'AES-GCM',
    false, // non-extractable: the data key can never be read back out
    ['encrypt', 'decrypt'],
  )
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
