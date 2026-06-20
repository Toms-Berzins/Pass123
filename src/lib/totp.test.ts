import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  formatTOTPSecret,
  generateTOTP,
  generateTOTPSecret,
  generateTOTPUri,
  isValidTOTPSecret,
  normalizeTOTPSecret,
  parseTOTPUri,
} from './totp'

// RFC 6238 test seed: ASCII "12345678901234567890" → base32.
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('base32', () => {
  it('decodes the RFC seed back to the ASCII secret', () => {
    expect(new TextDecoder().decode(base32Decode(SEED))).toBe('12345678901234567890')
  })

  it('round-trips a generated secret', () => {
    const s = generateTOTPSecret()
    expect(isValidTOTPSecret(s)).toBe(true)
    expect(() => base32Decode(s)).not.toThrow()
  })
})

describe('generateTOTP — RFC 6238 SHA-1 vectors (8-digit)', () => {
  const cases: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ]
  for (const [t, expected] of cases) {
    it(`t=${t} → ${expected}`, async () => {
      const { code } = await generateTOTP(
        { secret: SEED, algorithm: 'SHA-1', digits: 8, period: 30 },
        t * 1000,
      )
      expect(code).toBe(expected)
    })
  }

  it('reports the countdown within the period', async () => {
    const r = await generateTOTP({ secret: SEED }, 1000 * (1234567890 + 5)) // 5s into a window
    expect(r.remainingSeconds).toBe(25)
    expect(r.progress).toBeCloseTo(25 / 30)
  })

  it('defaults to 6 digits', async () => {
    const { code } = await generateTOTP({ secret: SEED }, 59_000)
    expect(code).toHaveLength(6)
  })
})

describe('secret helpers', () => {
  it('validates length and alphabet', () => {
    expect(isValidTOTPSecret(SEED)).toBe(true)
    expect(isValidTOTPSecret('jbsw y3dp')).toBe(false) // too short
    expect(isValidTOTPSecret('JBSWY3DPEHPK3PX1')).toBe(false) // '1' not in base32
  })

  it('normalizes and formats', () => {
    expect(normalizeTOTPSecret('jbsw y3dp\tehpk')).toBe('JBSWY3DPEHPK')
    expect(formatTOTPSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP')
  })
})

describe('otpauth URI', () => {
  it('parses issuer, account, and parameters', () => {
    const cfg = parseTOTPUri(
      `otpauth://totp/GitHub:alice@example.com?secret=${SEED}&issuer=GitHub&algorithm=SHA256&digits=8&period=60`,
    )
    expect(cfg.secret).toBe(SEED)
    expect(cfg.issuer).toBe('GitHub')
    expect(cfg.account).toBe('alice@example.com')
    expect(cfg.algorithm).toBe('SHA-256')
    expect(cfg.digits).toBe(8)
    expect(cfg.period).toBe(60)
  })

  it('fills defaults when params are absent', () => {
    const cfg = parseTOTPUri(`otpauth://totp/Acme?secret=${SEED}`)
    expect(cfg.algorithm).toBe('SHA-1')
    expect(cfg.digits).toBe(6)
    expect(cfg.period).toBe(30)
  })

  it('rejects non-TOTP / malformed URIs', () => {
    expect(() => parseTOTPUri('https://example.com')).toThrow()
    expect(() => parseTOTPUri('otpauth://hotp/x?secret=' + SEED)).toThrow()
    expect(() => parseTOTPUri('otpauth://totp/x?secret=short')).toThrow()
  })

  it('round-trips through generate → parse', () => {
    const uri = generateTOTPUri({ secret: SEED, algorithm: 'SHA-1', digits: 6, period: 30, issuer: 'Acme', account: 'me' })
    const cfg = parseTOTPUri(uri)
    expect(cfg.secret).toBe(SEED)
    expect(cfg.issuer).toBe('Acme')
    expect(cfg.account).toBe('me')
  })
})
