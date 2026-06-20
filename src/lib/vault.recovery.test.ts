import { describe, expect, it } from 'vitest'
import {
  changeMasterPassword,
  createVault,
  hasRecoveryPhrase,
  loadData,
  newEntry,
  saveData,
  setupRecoveryPhrase,
  unlockVault,
} from './vault'
import { validateMnemonic } from './bip39'
import { readStoredVault, type StoredVaultV2 } from './storage'

const ITERS = 1000
const MASTER = 'a-strong-master-password'

async function stored(): Promise<StoredVaultV2> {
  const s = await readStoredVault()
  if (!s || s.version !== 2) throw new Error('expected a v2 vault')
  return s
}

describe('recovery phrase (v0.3 ②)', () => {
  it('setupRecoveryPhrase returns a valid 12-word phrase and adds a recovery wrap', async () => {
    await createVault(MASTER, ITERS)
    expect(await hasRecoveryPhrase()).toBe(false)

    const phrase = await setupRecoveryPhrase(MASTER)
    expect(phrase.split(' ')).toHaveLength(12)
    expect(await validateMnemonic(phrase)).toBe(true)
    expect(await hasRecoveryPhrase()).toBe(true)

    const s = await stored()
    expect(s.keyWraps.map((w) => w.method)).toEqual(['password', 'recovery'])
    // The phrase must never be stored — only its HKDF-wrapped vault key.
    expect(JSON.stringify(s)).not.toContain(phrase)
  })

  it('the phrase unlocks the same vault data as the master password', async () => {
    const key = await createVault(MASTER, ITERS)
    const data = await loadData(key)
    data.entries.push(newEntry({ title: 'Bank', url: 'bank.com', username: 'me', password: 's3cret', notes: '' }))
    await saveData(key, data)

    const phrase = await setupRecoveryPhrase(MASTER)
    const viaPhrase = await unlockVault(phrase)
    expect(viaPhrase.data.entries[0].password).toBe('s3cret')
  })

  it('Regenerate replaces the old phrase: the previous one stops working', async () => {
    await createVault(MASTER, ITERS)
    const first = await setupRecoveryPhrase(MASTER)
    const second = await setupRecoveryPhrase(MASTER)
    expect(second).not.toBe(first)

    // Still exactly one recovery wrap, not two.
    expect((await stored()).keyWraps.filter((w) => w.method === 'recovery')).toHaveLength(1)
    await expect(unlockVault(first)).rejects.toBeDefined()
    expect((await unlockVault(second)).data.entries).toEqual([])
  })

  it('recover-then-reset: phrase changes the master password, old password dies', async () => {
    await createVault(MASTER, ITERS)
    const phrase = await setupRecoveryPhrase(MASTER)

    await changeMasterPassword(phrase, 'brand-new-master', ITERS)
    expect((await unlockVault('brand-new-master')).data.entries).toEqual([])
    await expect(unlockVault(MASTER)).rejects.toBeDefined()
    // The recovery phrase still works after a password reset.
    expect((await unlockVault(phrase)).data.entries).toEqual([])
  })

  it('a wrong/garbage phrase does not unlock', async () => {
    await createVault(MASTER, ITERS)
    await setupRecoveryPhrase(MASTER)
    await expect(unlockVault('totally not the recovery phrase you wrote down ok')).rejects.toBeDefined()
  })
})
