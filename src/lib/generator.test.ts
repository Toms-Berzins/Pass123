import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPTIONS,
  entropyBits,
  generatePassword,
  poolSize,
  strengthFromEntropy,
  type GeneratorOptions,
} from './generator'

const base: GeneratorOptions = {
  length: 24,
  lowercase: true,
  uppercase: true,
  numbers: true,
  symbols: true,
  excludeAmbiguous: false,
}

describe('generatePassword', () => {
  it('respects the requested length', () => {
    expect(generatePassword({ ...base, length: 32 })).toHaveLength(32)
  })

  it('clamps length to the [4, 128] range', () => {
    expect(generatePassword({ ...base, length: 1 })).toHaveLength(4)
    expect(generatePassword({ ...base, length: 999 })).toHaveLength(128)
  })

  it('only uses characters from enabled sets', () => {
    const pw = generatePassword({
      ...base,
      uppercase: false,
      numbers: false,
      symbols: false,
      length: 200,
    })
    expect(pw).toMatch(/^[a-z]+$/)
  })

  it('excludes ambiguous characters when requested', () => {
    const pw = generatePassword({ ...base, excludeAmbiguous: true, length: 500 })
    expect(pw).not.toMatch(/[l1IO0o`|]/)
  })

  it('throws when no character set is selected', () => {
    expect(() =>
      generatePassword({
        ...base,
        lowercase: false,
        uppercase: false,
        numbers: false,
        symbols: false,
      }),
    ).toThrow(/at least one/i)
  })

  it('produces different output across calls (no fixed seed)', () => {
    expect(generatePassword(base)).not.toBe(generatePassword(base))
  })
})

describe('entropy & strength', () => {
  it('computes pool size from enabled sets', () => {
    expect(poolSize({ ...base, uppercase: false, numbers: false, symbols: false })).toBe(26)
  })

  it('entropy grows with length and pool', () => {
    expect(entropyBits(20, 94)).toBeGreaterThan(entropyBits(8, 94))
    expect(entropyBits(20, 94)).toBeGreaterThan(entropyBits(20, 26))
  })

  it('maps entropy to strength buckets', () => {
    expect(strengthFromEntropy(30)).toBe('weak')
    expect(strengthFromEntropy(60)).toBe('fair')
    expect(strengthFromEntropy(100)).toBe('good')
    expect(strengthFromEntropy(140)).toBe('strong')
  })

  it('the default options yield a strong password', () => {
    const bits = entropyBits(DEFAULT_OPTIONS.length, poolSize(DEFAULT_OPTIONS))
    expect(strengthFromEntropy(bits)).toBe('strong')
  })
})
