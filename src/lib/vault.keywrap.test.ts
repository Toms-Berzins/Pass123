import { describe, expect, it } from 'vitest'
import { addKeyWrap, createVault, loadData, newEntry, saveData, unlockVault } from './vault'
import { deriveKey, encryptJSON, randomSalt, toBase64 } from './crypto'
import { readStoredVault, writeStoredVault, type StoredVaultV2 } from './storage'

// The key-wrapping refactor spike. PBKDF2 runs at a low iteration count here so the
// several derivations per test stay fast — correctness is independent of the count.
const ITERS = 1000
const MASTER = 'a-strong-master-password'
// Canonical BIP39 all-zeros test vector — a valid 12-word phrase, so the recovery
// wrap derives via HKDF over its entropy (not PBKDF2 over the raw string).
const RECOVERY =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

async function stored(): Promise<StoredVaultV2> {
  const s = await readStoredVault()
  if (!s || s.version !== 2) throw new Error('expected a v2 vault')
  return s
}

describe('key-wrapping model', () => {
  it('createVault stores a v2 vault: one password wrap + a payload, no raw key', async () => {
    await createVault(MASTER, ITERS)
    const s = await stored()
    expect(s.keyWraps).toHaveLength(1)
    expect(s.keyWraps[0].method).toBe('password')
    expect(s.payload.data).toBeTypeOf('string')
    // Nothing on disk should resemble a raw/derivable key — only wrapped ciphertext.
    expect(JSON.stringify(s)).not.toContain('"key"')
  })

  it('round-trips create -> unlock -> save -> fresh unlock', async () => {
    const key = await createVault(MASTER, ITERS)
    const data = await loadData(key)
    data.entries.push(newEntry({ title: 'GitHub', url: 'github.com', username: 'me', password: 'pw', notes: '' }))
    await saveData(key, data)

    const { data: afterUnlock } = await unlockVault(MASTER)
    expect(afterUnlock.entries.map((e) => e.title)).toEqual(['GitHub'])
  })

  it('rejects the wrong master password (no wrap matches)', async () => {
    await createVault(MASTER, ITERS)
    await expect(unlockVault('not-the-password')).rejects.toBeDefined()
  })
})

describe('additive unlock methods (the spike headline)', () => {
  it('a second wrap over the same vault key unlocks the same data with EITHER secret', async () => {
    const key = await createVault(MASTER, ITERS)
    const data = await loadData(key)
    data.entries.push(newEntry({ title: 'Bank', url: 'bank.com', username: 'me', password: 's3cret', notes: '' }))
    await saveData(key, data)

    // Add a recovery secret over the same vault key — no re-encryption of the payload.
    const payloadBefore = (await stored()).payload.data
    await addKeyWrap(MASTER, RECOVERY, 'recovery', ITERS)
    const s = await stored()
    expect(s.keyWraps.map((w) => w.method)).toEqual(['password', 'recovery'])
    expect(s.payload.data).toBe(payloadBefore) // payload untouched — only a wrap was added

    // Both secrets unlock and yield identical data.
    const viaMaster = await unlockVault(MASTER)
    const viaRecovery = await unlockVault(RECOVERY)
    expect(viaRecovery.data).toEqual(viaMaster.data)
    expect(viaRecovery.data.entries[0].password).toBe('s3cret')
  })

  it('changes written under one secret are readable under the other (same vault key)', async () => {
    await createVault(MASTER, ITERS)
    await addKeyWrap(MASTER, RECOVERY, 'recovery', ITERS)

    // Edit while unlocked via the recovery secret...
    const r = await unlockVault(RECOVERY)
    r.data.entries.push(newEntry({ title: 'Email', url: 'mail.com', username: 'u', password: 'p', notes: '' }))
    await saveData(r.key, r.data)

    // ...and read it back via the master password.
    const m = await unlockVault(MASTER)
    expect(m.data.entries.map((e) => e.title)).toEqual(['Email'])
  })

  it('rejects a secret that matches no wrap even after a second wrap exists', async () => {
    await createVault(MASTER, ITERS)
    await addKeyWrap(MASTER, RECOVERY, 'recovery', ITERS)
    await expect(unlockVault('neither-secret')).rejects.toBeDefined()
  })
})

describe('legacy v1 -> v2 migration', () => {
  // Write a vault in the old v0.2 format: master-derived key encrypts the payload directly.
  async function writeLegacyVault(master: string, entries: ReturnType<typeof newEntry>[]) {
    const salt = randomSalt()
    const key = await deriveKey(master, salt, ITERS)
    const payload = await encryptJSON(key, { entries })
    await writeStoredVault({ version: 1, salt: toBase64(salt), iterations: ITERS, payload })
  }

  it('migrates on first unlock, preserves data, and re-keys to a wrapped v2 vault', async () => {
    const legacyEntry = newEntry({ title: 'Old', url: 'old.com', username: 'u', password: 'p', notes: '' })
    await writeLegacyVault(MASTER, [legacyEntry])

    const { data } = await unlockVault(MASTER)
    expect(data.entries.map((e) => e.title)).toEqual(['Old'])

    // Storage is now v2 with a single password wrap.
    const s = await stored()
    expect(s.version).toBe(2)
    expect(s.keyWraps).toHaveLength(1)
    expect(s.keyWraps[0].method).toBe('password')

    // A second unlock now takes the v2 path and still works; wrong password still fails.
    expect((await unlockVault(MASTER)).data.entries).toHaveLength(1)
    await expect(unlockVault('wrong')).rejects.toBeDefined()
  })

  it('a migrated vault can immediately gain a recovery wrap', async () => {
    await writeLegacyVault(MASTER, [])
    await unlockVault(MASTER) // migrate
    await addKeyWrap(MASTER, RECOVERY, 'recovery', ITERS)
    expect((await unlockVault(RECOVERY)).data.entries).toEqual([])
  })
})
