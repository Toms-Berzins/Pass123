/**
 * Minimal BIP39 mnemonic implementation for the recovery phrase, Web-Crypto only.
 *
 * A 12-word phrase encodes 128 bits of entropy plus a 4-bit SHA-256 checksum
 * (132 bits = 12 × 11). The phrase itself is the recovery secret; the vault key
 * is wrapped under a key derived from its entropy (see `crypto.deriveKeyFromEntropy`).
 * We only generate/validate English 12-word phrases — no seed/PBKDF2 step, since
 * we use the entropy directly as HKDF input, not as a wallet seed.
 */

import { WORDLIST } from './bip39-wordlist'

const ENTROPY_BYTES = 16 // 128 bits → 12 words
const WORD_COUNT = 12

/** Normalize for comparison: trim, collapse whitespace, lowercase. */
export function normalizeMnemonic(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Generate a fresh 12-word English BIP39 mnemonic. */
export async function generateMnemonic(): Promise<string> {
  const entropy = crypto.getRandomValues(new Uint8Array(ENTROPY_BYTES))
  return entropyToMnemonic(entropy)
}

/** Encode 16 entropy bytes as a 12-word phrase (appending the SHA-256 checksum). */
export async function entropyToMnemonic(entropy: Uint8Array): Promise<string> {
  if (entropy.length !== ENTROPY_BYTES) throw new Error('Recovery entropy must be 16 bytes')
  const checksumBits = (entropy.length * 8) / 32 // = 4 for 128-bit entropy
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy as BufferSource))
  const bits = [...bytesToBits(entropy), ...bytesToBits(hash).slice(0, checksumBits)]

  const words: string[] = []
  for (let i = 0; i < WORD_COUNT; i++) {
    let index = 0
    for (let j = 0; j < 11; j++) index = (index << 1) | bits[i * 11 + j]
    words.push(WORDLIST[index])
  }
  return words.join(' ')
}

/**
 * Decode a phrase back to its 16 entropy bytes, throwing if it is not a valid
 * 12-word English mnemonic with a matching checksum. This doubles as validation.
 */
export async function mnemonicToEntropy(phrase: string): Promise<Uint8Array> {
  const words = normalizeMnemonic(phrase).split(' ')
  if (words.length !== WORD_COUNT) throw new Error('Recovery phrase must be 12 words')

  const bits: number[] = []
  for (const word of words) {
    const index = WORDLIST.indexOf(word)
    if (index === -1) throw new Error(`"${word}" is not a recovery word`)
    for (let j = 10; j >= 0; j--) bits.push((index >> j) & 1)
  }

  const checksumBits = bits.length - bits.length / 33 * 32 // 132 → 4
  const entropy = bitsToBytes(bits.slice(0, bits.length - checksumBits))
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy as BufferSource))
  const expectedBits = bytesToBits(expected).slice(0, checksumBits)
  if (!expectedBits.every((b, i) => b === bits[bits.length - checksumBits + i])) {
    throw new Error('Recovery phrase checksum does not match')
  }
  return entropy
}

/** True if `phrase` is a valid 12-word English mnemonic with a correct checksum. */
export async function validateMnemonic(phrase: string): Promise<boolean> {
  try {
    await mnemonicToEntropy(phrase)
    return true
  } catch {
    return false
  }
}

function bytesToBits(bytes: Uint8Array): number[] {
  const bits: number[] = []
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1)
  return bits
}

function bitsToBytes(bits: number[]): Uint8Array {
  const bytes = new Uint8Array(bits.length / 8)
  for (let i = 0; i < bytes.length; i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j]
    bytes[i] = byte
  }
  return bytes
}
