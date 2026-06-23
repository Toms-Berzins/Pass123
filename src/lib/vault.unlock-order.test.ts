import { describe, expect, it } from 'vitest'
import { addKeyWrap, createVault, loadData, newEntry, saveData, unlockVault } from './vault'
import { readStoredVault, writeStoredVault, type KeyWrap, type StoredVaultV2 } from './storage'
import { toBase64 } from './crypto'

const ITERS = 1000
const MASTER = 'order-test-master'
// Canonical BIP39 all-zeros test vector — valid 12-word phrase.
const RECOVERY =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr]
  return arr.flatMap((x, i) =>
    permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [x, ...rest]),
  )
}

function randBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

/**
 * A KeyWrap with random garbage ciphertext. AES-GCM auth-tag verification will
 * always fail for any derived key, so unwrapVaultKeyBytes silently skips it and
 * moves on to the next wrap.
 */
function junkWrap(): KeyWrap {
  return {
    method: 'password',
    salt: toBase64(randBytes(16)),
    iterations: 1,
    wrapped: { iv: toBase64(randBytes(12)), data: toBase64(randBytes(48)) },
  }
}

async function storedV2(): Promise<StoredVaultV2> {
  const s = await readStoredVault()
  if (!s || s.version !== 2) throw new Error('expected v2')
  return s
}

// ---------------------------------------------------------------------------
// Property 1 — order-independence
// ---------------------------------------------------------------------------

describe('unlockVault trial order — order-independence', () => {
  it('all 2! permutations of [password, recovery] unlock with either secret', async () => {
    await createVault(MASTER, ITERS)
    await addKeyWrap(MASTER, RECOVERY, 'recovery', ITERS)

    // Seed an entry so we can verify the payload survived every permutation.
    const { key } = await unlockVault(MASTER)
    const data = await loadData(key)
    data.entries.push(
      newEntry({ title: 'Seed', url: 'seed.com', username: 'u', password: 'p', notes: '' }),
    )
    await saveData(key, data)

    const s = await storedV2()
    expect(s.keyWraps).toHaveLength(2)

    for (const order of permutations(s.keyWraps)) {
      await writeStoredVault({ ...s, keyWraps: order })
      for (const secret of [MASTER, RECOVERY]) {
        const result = await unlockVault(secret)
        expect(result.data.entries).toHaveLength(1)
        expect(result.data.entries[0].title).toBe('Seed')
      }
    }
  })

  it('wrong secret fails in every wrap order', async () => {
    await createVault(MASTER, ITERS)
    await addKeyWrap(MASTER, RECOVERY, 'recovery', ITERS)
    const s = await storedV2()

    for (const order of permutations(s.keyWraps)) {
      await writeStoredVault({ ...s, keyWraps: order })
      await expect(unlockVault('not-valid')).rejects.toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Property 2 — junk-wrap robustness
// ---------------------------------------------------------------------------

describe('unlockVault trial order — junk-wrap robustness', () => {
  it('a junk wrap before the real one is skipped', async () => {
    await createVault(MASTER, ITERS)
    const s = await storedV2()
    await writeStoredVault({ ...s, keyWraps: [junkWrap(), s.keyWraps[0]] })
    await expect(unlockVault(MASTER)).resolves.toBeDefined()
  })

  it('a junk wrap after the real one does not affect the result', async () => {
    await createVault(MASTER, ITERS)
    const s = await storedV2()
    await writeStoredVault({ ...s, keyWraps: [s.keyWraps[0], junkWrap()] })
    await expect(unlockVault(MASTER)).resolves.toBeDefined()
  })

  it('multiple junk wraps surrounding the real one: unlock still succeeds', async () => {
    await createVault(MASTER, ITERS)
    const s = await storedV2()
    const [real] = s.keyWraps
    await writeStoredVault({
      ...s,
      keyWraps: [junkWrap(), junkWrap(), real, junkWrap(), junkWrap()],
    })
    await expect(unlockVault(MASTER)).resolves.toBeDefined()
  })

  it('all-junk vault: unlock throws regardless of which secret is tried', async () => {
    await createVault(MASTER, ITERS)
    const s = await storedV2()
    await writeStoredVault({ ...s, keyWraps: [junkWrap(), junkWrap(), junkWrap()] })
    await expect(unlockVault(MASTER)).rejects.toBeDefined()
    await expect(unlockVault(RECOVERY)).rejects.toBeDefined()
  })

  // ---------------------------------------------------------------------------
  // Property 3 — position sweep
  // ---------------------------------------------------------------------------

  it('real wrap at each index among N − 1 junk wraps: always unlocks', async () => {
    await createVault(MASTER, ITERS)
    const s = await storedV2()
    const [real] = s.keyWraps
    const N = 5

    for (let pos = 0; pos < N; pos++) {
      const junks = Array.from({ length: N - 1 }, junkWrap)
      const wraps = [...junks.slice(0, pos), real, ...junks.slice(pos)]
      await writeStoredVault({ ...s, keyWraps: wraps })
      await expect(unlockVault(MASTER)).resolves.toBeDefined()
    }
  })
})
