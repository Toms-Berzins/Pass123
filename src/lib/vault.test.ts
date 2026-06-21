import { describe, expect, it } from 'vitest'
import {
  captureDecision,
  confirmProvisionalEntry,
  createVault,
  loadData,
  matchEntries,
  newEntry,
  saveData,
  suggestEmails,
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

  it('surfaces an apex entry on a subdomain of the same site (v0.5)', () => {
    // The whole point of registrable-domain matching: a saved example.com entry
    // should now autofill on login.example.com.
    expect(matchEntries(data, 'login.example.com').map((e) => e.title)).toEqual(['WWW'])
  })

  it('ranks the more specific host first', () => {
    const ranked: VaultData = {
      entries: [
        newEntry({ title: 'Sibling', url: 'mail.acme.com', username: 'a', password: '', notes: '' }),
        newEntry({ title: 'Exact', url: 'login.acme.com', username: 'b', password: '', notes: '' }),
        newEntry({ title: 'Apex', url: 'acme.com', username: 'c', password: '', notes: '' }),
      ],
    }
    expect(matchEntries(ranked, 'login.acme.com').map((e) => e.title)).toEqual(['Exact', 'Apex', 'Sibling'])
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

  it('treats a subdomain login as the same account for update (v0.5)', () => {
    // Logging in as the saved user on a subdomain should update, not duplicate.
    const decision = captureDecision(data, 'gist.github.com', 'me', 'rotated')
    expect(decision).toEqual({ kind: 'update', id: entry.id, title: 'GitHub' })
  })

  it('does not cross registrable domains when deciding (wrong-account safety)', () => {
    // A login on an unrelated site must never resolve to this entry.
    expect(captureDecision(data, 'github.io', 'me', 'whatever').kind).toBe('save')
  })
})

describe('suggestEmails', () => {
  const mk = (username: string, updatedAt: number) => ({
    ...newEntry({ title: 't', url: 'u.com', username, password: 'p', notes: '' }),
    updatedAt,
  })

  it('returns email-looking usernames, ignoring non-emails', () => {
    const data: VaultData = { entries: [mk('me@example.com', 1), mk('plainuser', 2), mk('', 3)] }
    expect(suggestEmails(data)).toEqual(['me@example.com'])
  })

  it('dedupes case-insensitively and ranks by frequency then recency', () => {
    const data: VaultData = {
      entries: [
        mk('Me@Example.com', 10),
        mk('me@example.com', 20), // same as above (different case) -> count 2
        mk('other@x.com', 30),
        mk('other@x.com', 40), // count 2, but more recent than me@…
        mk('rare@y.com', 50), // count 1
      ],
    }
    // both have count 2; other@x.com is more recent (40 > 20) so it ranks first.
    expect(suggestEmails(data)).toEqual(['other@x.com', 'Me@Example.com', 'rare@y.com'])
  })

  it('is empty for a vault with no email usernames', () => {
    expect(suggestEmails({ entries: [mk('alice', 1)] })).toEqual([])
  })
})

describe('confirmProvisionalEntry', () => {
  it('clears the provisional flag and bumps updatedAt', () => {
    const entry = newEntry({ title: 'x', url: 'x.com', username: 'me', password: 'pw', notes: '', provisional: true })
    const confirmed = confirmProvisionalEntry(entry, 'me')
    expect(confirmed.provisional).toBe(false)
    expect(confirmed.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt)
  })

  it('adopts a username typed after the proactive save', () => {
    const entry = newEntry({ title: 'x', url: 'x.com', username: '', password: 'pw', notes: '', provisional: true })
    expect(confirmProvisionalEntry(entry, '  new@user.com  ').username).toBe('new@user.com')
  })

  it('keeps the existing username when none is supplied', () => {
    const entry = newEntry({ title: 'x', url: 'x.com', username: 'kept', password: 'pw', notes: '', provisional: true })
    expect(confirmProvisionalEntry(entry, '').username).toBe('kept')
  })
})
