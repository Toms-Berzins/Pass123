import { describe, expect, it } from 'vitest'
import {
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  normalizeMnemonic,
  validateMnemonic,
} from './bip39'

// Official BIP39 English test vectors (entropy hex → mnemonic).
const VECTORS: [string, string][] = [
  [
    '00000000000000000000000000000000',
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ],
  [
    '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
    'legal winner thank year wave sausage worth useful legal winner thank yellow',
  ],
  [
    '80808080808080808080808080808080',
    'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  ],
  [
    'ffffffffffffffffffffffffffffffff',
    'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  ],
]

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('bip39', () => {
  it('encodes the official test vectors', async () => {
    for (const [hex, phrase] of VECTORS) {
      expect(await entropyToMnemonic(hexToBytes(hex))).toBe(phrase)
    }
  })

  it('decodes phrases back to their exact entropy', async () => {
    for (const [hex, phrase] of VECTORS) {
      expect([...(await mnemonicToEntropy(phrase))]).toEqual([...hexToBytes(hex)])
    }
  })

  it('generates valid, 12-word, decodable phrases', async () => {
    for (let i = 0; i < 5; i++) {
      const phrase = await generateMnemonic()
      expect(phrase.split(' ')).toHaveLength(12)
      expect(await validateMnemonic(phrase)).toBe(true)
      expect(await mnemonicToEntropy(phrase)).toHaveLength(16)
    }
  })

  it('generates a different phrase each time', async () => {
    const a = await generateMnemonic()
    const b = await generateMnemonic()
    expect(a).not.toBe(b)
  })

  it('normalizes whitespace and case before validating', async () => {
    const messy = '  Abandon abandon   abandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT '
    expect(normalizeMnemonic(messy)).toBe(VECTORS[0][1])
    expect(await validateMnemonic(messy)).toBe(true)
  })

  it('rejects wrong length, unknown words, and bad checksums', async () => {
    expect(await validateMnemonic('abandon abandon about')).toBe(false) // too short
    expect(await validateMnemonic(VECTORS[0][1].replace('about', 'notaword'))).toBe(false)
    // Right words, wrong checksum: swap the last word for another valid one.
    expect(await validateMnemonic(VECTORS[0][1].replace('about', 'abandon'))).toBe(false)
    await expect(mnemonicToEntropy('not a real phrase at all here friend')).rejects.toBeDefined()
  })
})
