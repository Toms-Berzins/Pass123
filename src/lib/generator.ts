/** Password & passphrase generation with a cryptographically secure RNG. */

import { WORDLIST } from './bip39-wordlist'

export interface GeneratorOptions {
  length: number
  lowercase: boolean
  uppercase: boolean
  numbers: boolean
  symbols: boolean
  /** Drop visually ambiguous characters (l, 1, I, O, 0, etc.). */
  excludeAmbiguous: boolean
}

export const DEFAULT_OPTIONS: GeneratorOptions = {
  length: 20,
  lowercase: true,
  uppercase: true,
  numbers: true,
  symbols: true,
  excludeAmbiguous: true,
}

const SETS = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  numbers: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>?',
}
const AMBIGUOUS = new Set('l1IO0o`|'.split(''))

/** Unbiased index in [0, max) using rejection sampling over a Uint32. */
function secureIndex(max: number): number {
  const limit = Math.floor(0xffffffff / max) * max
  const buf = new Uint32Array(1)
  let x: number
  do {
    crypto.getRandomValues(buf)
    x = buf[0]
  } while (x >= limit)
  return x % max
}

export function generatePassword(opts: GeneratorOptions): string {
  let pool = ''
  if (opts.lowercase) pool += SETS.lowercase
  if (opts.uppercase) pool += SETS.uppercase
  if (opts.numbers) pool += SETS.numbers
  if (opts.symbols) pool += SETS.symbols
  if (opts.excludeAmbiguous) {
    pool = [...pool].filter((c) => !AMBIGUOUS.has(c)).join('')
  }
  if (!pool) throw new Error('Select at least one character set')

  const length = Math.max(4, Math.min(128, opts.length))
  let out = ''
  for (let i = 0; i < length; i++) out += pool[secureIndex(pool.length)]
  return out
}

/** Shannon entropy in bits for a uniformly-random string from a pool. */
export function entropyBits(length: number, poolSize: number): number {
  return Math.round(length * Math.log2(poolSize))
}

export function poolSize(opts: GeneratorOptions): number {
  let pool = ''
  if (opts.lowercase) pool += SETS.lowercase
  if (opts.uppercase) pool += SETS.uppercase
  if (opts.numbers) pool += SETS.numbers
  if (opts.symbols) pool += SETS.symbols
  if (opts.excludeAmbiguous) pool = [...pool].filter((c) => !AMBIGUOUS.has(c)).join('')
  return pool.length
}

// ---------- Passphrase (diceware-style) ----------

export interface PassphraseOptions {
  /** Number of words. */
  words: number
  /** Joiner between words. */
  separator: string
  /** Capitalize the first letter of each word. */
  capitalize: boolean
  /** Append a random digit (0–9) as an extra token. */
  includeNumber: boolean
}

export const DEFAULT_PASSPHRASE: PassphraseOptions = {
  words: 4,
  separator: '-',
  capitalize: false,
  includeNumber: false,
}

// The recovery wordlist doubles as the passphrase wordlist: 2048 words = 11 bits each.
const PASSPHRASE_WORDS = 2048

/** Generate a passphrase by drawing uniformly-random words from the wordlist. */
export function generatePassphrase(opts: PassphraseOptions): string {
  const count = Math.max(3, Math.min(12, opts.words))
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    let word = WORDLIST[secureIndex(PASSPHRASE_WORDS)]
    if (opts.capitalize) word = word[0].toUpperCase() + word.slice(1)
    parts.push(word)
  }
  if (opts.includeNumber) parts.push(String(secureIndex(10)))
  return parts.join(opts.separator)
}

/**
 * Entropy of a passphrase. Words contribute log2(2048)=11 bits each; an optional
 * appended digit adds log2(10). Capitalization is deterministic, so it adds nothing.
 */
export function passphraseEntropyBits(opts: PassphraseOptions): number {
  const count = Math.max(3, Math.min(12, opts.words))
  const bits = count * Math.log2(PASSPHRASE_WORDS) + (opts.includeNumber ? Math.log2(10) : 0)
  return Math.round(bits)
}

export type Strength = 'weak' | 'fair' | 'good' | 'strong'

export function strengthFromEntropy(bits: number): Strength {
  if (bits < 50) return 'weak'
  if (bits < 80) return 'fair'
  if (bits < 120) return 'good'
  return 'strong'
}
