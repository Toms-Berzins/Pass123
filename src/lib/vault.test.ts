import { describe, expect, it } from 'vitest'
import {
  captureDecision,
  createVault,
  loadData,
  matchEntries,
  newEntry,
  saveData,
  unlockVault,
  type VaultData,
} from './vault'
import { vaultExists } from './storage'

// These exercise the full storage round-trip against the in-memory chrome stub
// from test/setup.ts. PBKDF2 runs at its real iteration count here, but only a
// couple of derivations happen per test so it stays fast enough.

const MASTER = 'a-strong-master-password'

describe('vault lifecycle', () => {
  it('starts with no vault', async () => {
    expect(await vaultExists()).toBe(false)
  })

  it('creates then unlocks with the correct password', async () => {
    await createVault(MASTER)
    expect(await vaultExists()).toBe(true)

    const { data } = await unlockVault(MASTER)
    expect(data.entries).toEqual([])
  })

  it('rejects an incorrect master password on unlock', async () => {
    await createVault(MASTER)
    await expect(unlockVault('not-the-password')).rejects.toBeDefined()
  })

  it('persists added entries across save/load', async () => {
    const key = await createVault(MASTER)
    const data = await loadData(key)
    data.entries.push(newEntry({ title: 'GitHub', url: 'github.com', username: 'me', password: 'pw', notes: '' }))
    await saveData(key, data)

    const reloaded = await loadData(key)
    expect(reloaded.entries).toHaveLength(1)
    expect(reloaded.entries[0].title).toBe('GitHub')
    expect(reloaded.entries[0].id).toBeTypeOf('string')
  })

  it('survives a fresh unlock (data is really encrypted on disk)', async () => {
    const key = await createVault(MASTER)
    const data = await loadData(key)
    data.entries.push(newEntry({ title: 'X', url: 'x.com', username: 'u', password: 'p', notes: '' }))
    await saveData(key, data)

    const { data: afterUnlock } = await unlockVault(MASTER)
    expect(afterUnlock.entries.map((e) => e.title)).toEqual(['X'])
  })
})

describe('newEntry', () => {
  it('assigns an id and timestamps', () => {
    const e = newEntry({ title: 't', url: '', username: '', password: '', notes: '' })
    expect(e.id).toMatch(/[0-9a-f-]{36}/)
    expect(e.createdAt).toBeLessThanOrEqual(Date.now())
    expect(e.updatedAt).toBe(e.createdAt)
  })
})

describe('matchEntries', () => {
  const data: VaultData = {
    entries: [
      newEntry({ title: 'GitHub', url: 'https://github.com/login', username: 'a', password: '', notes: '' }),
      newEntry({ title: 'WWW', url: 'www.example.com', username: 'b', password: '', notes: '' }),
      newEntry({ title: 'No URL', url: '', username: 'c', password: '', notes: '' }),
    ],
  }

  it('matches by hostname, ignoring path and www', () => {
    expect(matchEntries(data, 'github.com').map((e) => e.title)).toEqual(['GitHub'])
    expect(matchEntries(data, 'www.github.com').map((e) => e.title)).toEqual(['GitHub'])
    expect(matchEntries(data, 'example.com').map((e) => e.title)).toEqual(['WWW'])
  })

  it('returns nothing for unknown hosts', () => {
    expect(matchEntries(data, 'nope.test')).toEqual([])
  })
})

describe('captureDecision', () => {
  const entry = newEntry({ title: 'GitHub', url: 'github.com', username: 'me', password: 'old', notes: '' })
  const data: VaultData = { entries: [entry] }

  it('does nothing when a field is empty', () => {
    expect(captureDecision(data, 'github.com', '', 'pw').kind).toBe('none')
    expect(captureDecision(data, 'github.com', 'me', '').kind).toBe('none')
  })

  it('offers to save a brand-new host/username', () => {
    expect(captureDecision(data, 'gitlab.com', 'me', 'pw').kind).toBe('save')
    expect(captureDecision(data, 'github.com', 'other', 'pw').kind).toBe('save')
  })

  it('does nothing when the identical credential is already saved', () => {
    expect(captureDecision(data, 'github.com', 'me', 'old').kind).toBe('none')
    // username match is case-insensitive
    expect(captureDecision(data, 'github.com', 'ME', 'old').kind).toBe('none')
  })

  it('offers to update when the same username has a different password', () => {
    const decision = captureDecision(data, 'github.com', 'me', 'new-password')
    expect(decision).toEqual({ kind: 'update', id: entry.id, title: 'GitHub' })
  })
})
