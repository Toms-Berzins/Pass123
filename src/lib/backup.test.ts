import { describe, expect, it } from 'vitest'
import { decryptImport, encryptExport, EXPORT_FORMAT, mergeEntries } from './backup'
import { newEntry, type VaultData, type VaultEntry } from './vault'

const ITERS = 1000
const PW = 'export-password'

function sample(): VaultData {
  return {
    entries: [
      newEntry({ title: 'GitHub', url: 'github.com', username: 'me', password: 'gh-pw', notes: '' }),
      newEntry({ title: 'Bank', url: 'bank.com', username: 'acct', password: 's3cret', notes: 'pin 1234' }),
    ],
  }
}

describe('encrypted export/import', () => {
  it('round-trips data through encrypt -> decrypt', async () => {
    const data = sample()
    const json = await encryptExport(data, PW, ITERS)
    const back = await decryptImport(json, PW)
    expect(back.entries.map((e) => e.title)).toEqual(['GitHub', 'Bank'])
    expect(back.entries[1].password).toBe('s3cret')
  })

  it('writes a self-describing file and no plaintext secrets', async () => {
    const json = await encryptExport(sample(), PW, ITERS)
    const file = JSON.parse(json)
    expect(file.format).toBe(EXPORT_FORMAT)
    expect(file.cipher).toBe('AES-256-GCM')
    expect(json).not.toContain('s3cret')
    expect(json).not.toContain('gh-pw')
  })

  it('rejects the wrong export password', async () => {
    const json = await encryptExport(sample(), PW, ITERS)
    await expect(decryptImport(json, 'wrong-password')).rejects.toThrow(/wrong export password|corrupt/i)
  })

  it('rejects a non-backup / malformed file', async () => {
    await expect(decryptImport('{not json', PW)).rejects.toThrow(/invalid json/i)
    await expect(decryptImport(JSON.stringify({ hello: 'world' }), PW)).rejects.toThrow(/not a pass123 backup/i)
  })

  it('refuses an empty export password', async () => {
    await expect(encryptExport(sample(), '', ITERS)).rejects.toThrow(/export password/i)
  })
})

describe('mergeEntries', () => {
  const a: VaultEntry = newEntry({ title: 'A', url: 'a.com', username: 'u', password: 'p1', notes: '' })
  const b: VaultEntry = newEntry({ title: 'B', url: 'b.com', username: 'u', password: 'p2', notes: '' })

  it('adds new entries with fresh ids', () => {
    const { entries, added } = mergeEntries([a], [b])
    expect(added).toBe(1)
    expect(entries).toHaveLength(2)
    expect(entries[1].id).not.toBe(b.id) // re-keyed to avoid id collisions
    expect(entries[1].title).toBe('B')
  })

  it('skips exact duplicates (same url+username+password)', () => {
    const dupe = { ...a, id: 'different-id', title: 'A copy' }
    const { entries, added } = mergeEntries([a], [dupe])
    expect(added).toBe(0)
    expect(entries).toHaveLength(1)
  })

  it('imports a password change as a new entry (different password)', () => {
    const changed = { ...a, password: 'p1-new' }
    const { added } = mergeEntries([a], [changed])
    expect(added).toBe(1)
  })
})
