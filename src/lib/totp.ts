/**
 * RFC 6238 TOTP / RFC 4226 HOTP, Web-Crypto only (no third-party dep).
 *
 * The engine returns the countdown alongside the code so the UI never has to
 * recompute timing itself. TOTP secrets are secrets: they live as a `totp` field
 * on `VaultEntry`, so they ride the same AES-GCM envelope as passwords and only
 * ever exist decrypted in the background/popup — never in the page.
 */

export type TOTPAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512'

export interface TOTPConfig {
  /** base32 (RFC 4648) shared secret, no padding. */
  secret: string
  algorithm: TOTPAlgorithm
  digits: number
  period: number
  issuer?: string
  account?: string
}

export interface TOTPResult {
  code: string
  /** Seconds until the current code rolls over. */
  remainingSeconds: number
  /** Fraction of the period remaining, 0–1 (for a ring/bar). */
  progress: number
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const TOTP_DEFAULTS = { algorithm: 'SHA-1' as TOTPAlgorithm, digits: 6, period: 30 }

/** Strip spaces/padding and uppercase a base32 secret. */
export function normalizeTOTPSecret(secret: string): string {
  return secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
}

/** A secret is usable if it's ≥16 base32 chars (RFC-recommended minimum). */
export function isValidTOTPSecret(secret: string): boolean {
  const clean = normalizeTOTPSecret(secret)
  return clean.length >= 16 && /^[A-Z2-7]+$/.test(clean)
}

/** Group a secret into space-separated blocks of 4 for legible display. */
export function formatTOTPSecret(secret: string): string {
  return normalizeTOTPSecret(secret).replace(/(.{4})/g, '$1 ').trim()
}

/** Generate a fresh random base32 secret (default 160-bit, the SHA-1 norm). */
export function generateTOTPSecret(bytes = 20): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** Parse an `otpauth://totp/...` URI into a config (defaults filled in). */
export function parseTOTPUri(uri: string): TOTPConfig {
  let url: URL
  try {
    url = new URL(uri.trim())
  } catch {
    throw new Error('Not a valid otpauth URI')
  }
  if (url.protocol !== 'otpauth:' || url.host.toLowerCase() !== 'totp') {
    throw new Error('Not a TOTP otpauth URI')
  }
  const secret = url.searchParams.get('secret')
  if (!secret || !isValidTOTPSecret(secret)) throw new Error('otpauth URI has no valid secret')

  const label = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const [labelIssuer, account] = label.includes(':') ? label.split(/:(.*)/) : [undefined, label]
  return {
    secret: normalizeTOTPSecret(secret),
    algorithm: normalizeAlgorithm(url.searchParams.get('algorithm')),
    digits: clampInt(url.searchParams.get('digits'), TOTP_DEFAULTS.digits, 6, 10),
    period: clampInt(url.searchParams.get('period'), TOTP_DEFAULTS.period, 1, 120),
    issuer: url.searchParams.get('issuer') || labelIssuer || undefined,
    account: account?.trim() || undefined,
  }
}

/** Build an `otpauth://totp/...` URI (e.g. for re-export). */
export function generateTOTPUri(config: TOTPConfig): string {
  const label = config.issuer ? `${config.issuer}:${config.account ?? ''}` : (config.account ?? 'account')
  const p = new URLSearchParams({
    secret: normalizeTOTPSecret(config.secret),
    algorithm: config.algorithm.replace('-', ''),
    digits: String(config.digits),
    period: String(config.period),
  })
  if (config.issuer) p.set('issuer', config.issuer)
  return `otpauth://totp/${encodeURIComponent(label)}?${p.toString()}`
}

/**
 * Compute the current TOTP code plus its countdown. `nowMs` is injectable so the
 * RFC test vectors (and tests) are deterministic.
 */
export async function generateTOTP(
  config: { secret: string; algorithm?: TOTPAlgorithm; digits?: number; period?: number },
  nowMs: number = Date.now(),
): Promise<TOTPResult> {
  const digits = config.digits ?? TOTP_DEFAULTS.digits
  const period = config.period ?? TOTP_DEFAULTS.period
  const algorithm = config.algorithm ?? TOTP_DEFAULTS.algorithm
  const key = base32Decode(config.secret)
  const nowSec = Math.floor(nowMs / 1000)
  const counter = Math.floor(nowSec / period)
  const code = await hotp(key, counter, digits, algorithm)
  const remainingSeconds = period - (nowSec % period)
  return { code, remainingSeconds, progress: remainingSeconds / period }
}

// ---------- internals ----------

async function hotp(
  key: Uint8Array,
  counter: number,
  digits: number,
  algorithm: TOTPAlgorithm,
): Promise<string> {
  const msg = new Uint8Array(8)
  let c = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff
    c = Math.floor(c / 256)
  }
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  )
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, msg as BufferSource))
  const offset = hmac[hmac.length - 1] & 0x0f
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return (bin % 10 ** digits).toString().padStart(digits, '0')
}

export function base32Decode(input: string): Uint8Array {
  const clean = normalizeTOTPSecret(input)
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx === -1) throw new Error('Invalid base32 character in secret')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

function normalizeAlgorithm(raw: string | null): TOTPAlgorithm {
  switch ((raw ?? '').toUpperCase().replace('-', '')) {
    case 'SHA256':
      return 'SHA-256'
    case 'SHA512':
      return 'SHA-512'
    default:
      return 'SHA-1'
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}
