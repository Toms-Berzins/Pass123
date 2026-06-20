import { describe, expect, it } from 'vitest'
import {
  addBiometricWrap,
  createVault,
  getBiometricCredentialId,
  loadData,
  newEntry,
  removeBiometricWrap,
  saveData,
  unlockVault,
  unlockWithBiometric,
} from './vault'
import { readStoredVault, type StoredVaultV2 } from './storage'

const ITERS = 1000
const MASTER = 'a-strong-master-password'
// Stand-in for the 32-byte WebAuthn PRF output the platform authenticator returns.
const PRF = crypto.getRandomValues(new Uint8Array(32))
const OTHER_PRF = crypto.getRandomValues(new Uint8Array(32))

async function stored(): Promise<StoredVaultV2> {
  const s = await readStoredVault()
  if (!s || s.version !== 2) throw new Error('expected a v2 vault')
  return s
}

describe('biometric unlock (v0.4)', () => {
  it('adds a biometric wrap that unlocks the same vault key, alongside the password', async () => {
    const key = await createVault(MASTER, ITERS)
    const data = await loadData(key)
    data.entries.push(newEntry({ title: 'Bank', url: 'bank.com', username: 'me', password: 's3cret', notes: '' }))
    await saveData(key, data)

    const payloadBefore = (await stored()).payload.data
    await addBiometricWrap(MASTER, PRF, 'cred-abc')
    const s = await stored()
    expect(s.keyWraps.map((w) => w.method)).toEqual(['password', 'biometric'])
    expect(s.payload.data).toBe(payloadBefore) // additive — payload untouched
    expect(s.keyWraps.find((w) => w.method === 'biometric')?.credentialId).toBe('cred-abc')

    const viaBio = await unlockWithBiometric(PRF)
    expect(viaBio.data.entries[0].password).toBe('s3cret')
    // The password still works too.
    expect((await unlockVault(MASTER)).data.entries).toHaveLength(1)
  })

  it('exposes the credential id while locked (no key needed)', async () => {
    await createVault(MASTER, ITERS)
    expect(await getBiometricCredentialId()).toBeNull()
    await addBiometricWrap(MASTER, PRF, 'cred-xyz')
    expect(await getBiometricCredentialId()).toBe('cred-xyz')
  })

  it('rejects a different PRF output', async () => {
    await createVault(MASTER, ITERS)
    await addBiometricWrap(MASTER, PRF, 'cred-abc')
    await expect(unlockWithBiometric(OTHER_PRF)).rejects.toBeDefined()
  })

  it('re-enrolling replaces the single biometric wrap', async () => {
    await createVault(MASTER, ITERS)
    await addBiometricWrap(MASTER, PRF, 'cred-1')
    await addBiometricWrap(MASTER, OTHER_PRF, 'cred-2')
    const s = await stored()
    expect(s.keyWraps.filter((w) => w.method === 'biometric')).toHaveLength(1)
    expect(await getBiometricCredentialId()).toBe('cred-2')
    await expect(unlockWithBiometric(PRF)).rejects.toBeDefined() // old PRF no longer wraps
    expect((await unlockWithBiometric(OTHER_PRF)).data.entries).toEqual([])
  })

  it('removeBiometricWrap disables biometric but keeps the password', async () => {
    await createVault(MASTER, ITERS)
    await addBiometricWrap(MASTER, PRF, 'cred-1')
    await removeBiometricWrap()
    expect(await getBiometricCredentialId()).toBeNull()
    await expect(unlockWithBiometric(PRF)).rejects.toThrow(/not set up/i)
    expect((await unlockVault(MASTER)).data.entries).toEqual([])
  })

  it('unlockWithBiometric throws cleanly when biometric was never set up', async () => {
    await createVault(MASTER, ITERS)
    await expect(unlockWithBiometric(PRF)).rejects.toThrow(/not set up/i)
  })
})
