import { describe, expect, it } from 'vitest'
import {
  decryptJSON,
  deriveKey,
  encryptJSON,
  fromBase64,
  randomSalt,
  toBase64,
} from './crypto'

// Lower iteration count keeps tests fast; correctness is independent of the number.
const ITERS = 1000

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = randomSalt()
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes])
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips a JSON value with the same key', async () => {
    const salt = randomSalt()
    const key = await deriveKey('correct horse battery staple', salt, ITERS)
    const value = { entries: [{ id: '1', password: 's3cr3t!' }] }

    const blob = await encryptJSON(key, value)
    expect(blob.iv).toBeTypeOf('string')
    expect(blob.data).toBeTypeOf('string')

    const decrypted = await decryptJSON<typeof value>(key, blob)
    expect(decrypted).toEqual(value)
  })

  it('uses a fresh IV per encryption (non-deterministic ciphertext)', async () => {
    const salt = randomSalt()
    const key = await deriveKey('pw', salt, ITERS)
    const a = await encryptJSON(key, { x: 1 })
    const b = await encryptJSON(key, { x: 1 })
    expect(a.iv).not.toBe(b.iv)
    expect(a.data).not.toBe(b.data)
  })

  it('fails to decrypt with a key derived from the wrong password', async () => {
    const salt = randomSalt()
    const good = await deriveKey('right-password', salt, ITERS)
    const bad = await deriveKey('wrong-password', salt, ITERS)
    const blob = await encryptJSON(good, { secret: true })
    await expect(decryptJSON(bad, blob)).rejects.toBeDefined()
  })

  it('fails to decrypt tampered ciphertext (GCM auth)', async () => {
    const salt = randomSalt()
    const key = await deriveKey('pw', salt, ITERS)
    const blob = await encryptJSON(key, { secret: true })
    const tampered = { ...blob, data: toBase64(fromBase64(blob.data).map((b) => b ^ 0x01)) }
    await expect(decryptJSON(key, tampered)).rejects.toBeDefined()
  })
})

describe('deriveKey', () => {
  it('same password + salt produce interoperable keys', async () => {
    const salt = randomSalt()
    const k1 = await deriveKey('pw', salt, ITERS)
    const k2 = await deriveKey('pw', salt, ITERS)
    const blob = await encryptJSON(k1, { ok: 1 })
    expect(await decryptJSON(k2, blob)).toEqual({ ok: 1 })
  })

  it('different salts produce non-interoperable keys', async () => {
    const k1 = await deriveKey('pw', randomSalt(), ITERS)
    const k2 = await deriveKey('pw', randomSalt(), ITERS)
    const blob = await encryptJSON(k1, { ok: 1 })
    await expect(decryptJSON(k2, blob)).rejects.toBeDefined()
  })
})
