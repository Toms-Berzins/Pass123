/**
 * Service worker: the only context that holds the derived key and plaintext entries.
 *
 * Note: an MV3 service worker can be terminated when idle, which drops the in-memory
 * key and effectively re-locks the vault. That is an intentional, fail-safe behavior —
 * the popup re-checks status and prompts for the master password when needed.
 */

import type { EntryMeta, PendingInfo, Request, Response, StatusResponse } from './lib/messages'
import {
  addBiometricWrap,
  captureDecision,
  changeMasterPassword,
  confirmProvisionalEntry,
  createVault,
  getBiometricCredentialId,
  hasRecoveryPhrase,
  loadData,
  matchEntries,
  newEntry,
  removeBiometricWrap,
  saveData,
  setupRecoveryPhrase,
  suggestEmails,
  unlockVault,
  unlockWithBiometric,
  type VaultData,
  type VaultEntry,
} from './lib/vault'
import { decryptImport, encryptExport, mergeEntries } from './lib/backup'
import { DEFAULT_OPTIONS, generatePassword } from './lib/generator'
import { registrableDomain } from './lib/urlmatch'
import { fromBase64 } from './lib/crypto'
import { clearVault, vaultExists } from './lib/storage'
import {
  DEFAULT_SETTINGS,
  getSettings,
  SETTINGS_STORAGE_KEY,
  type Settings,
} from './lib/settings'

const AUTO_LOCK_ALARM = 'pass123-auto-lock'
const PENDING_TTL_MS = 2 * 60 * 1000
// Window in which a captured login may still be claimed by a *different-domain*
// landing page in the SAME tab — i.e. a submit-then-redirect across hosts. Kept
// short so a redirect is caught but later unrelated navigation in that tab is not.
//
// Tradeoff: this window catches the common OAuth redirect (submit on accounts.google.com,
// land on myapp.com) but also means any page the tab navigates to within 90 s receives
// the captured *username* via `pendingFor` (the banner must show it). The password never
// leaves the background worker. The risk materialises if the login host has an open
// redirect — an attacker could chain: login-submit → open-redirect → attacker.com, and
// the landing content script learns the username. `crossHostSurfaced` limits exposure to
// one page. Shorten this constant (e.g. 30 s) if open-redirect risk outweighs OAuth UX.
const CROSS_HOST_WINDOW_MS = 90 * 1000

// In-memory only. Never persisted.
let sessionKey: CryptoKey | null = null

// Cached preferences, kept in sync with storage so armAutoLock/capture stay sync.
let settings: Settings = DEFAULT_SETTINGS
void getSettings().then((s) => (settings = s))
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_STORAGE_KEY]) {
    settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_STORAGE_KEY].newValue as Partial<Settings>) }
  }
})

/** Credentials captured on submit, awaiting the user's save/update confirmation. */
interface PendingCapture {
  /** The original submit host, shown in the banner (not the landing host). */
  hostname: string
  username: string
  password: string
  action: 'save' | 'update'
  id?: string
  title?: string
  ts: number
  /** Tab the submit happened in — used to claim a cross-host redirect landing. */
  tabId?: number
  /** True once a banner has been surfaced via the cross-host (key-miss) fallback. */
  crossHostSurfaced: boolean
}
// Keyed by registrable domain (eTLD+1) so a submit on accounts.example.com and a
// landing on www.example.com resolve to the same pending entry.
const pending = new Map<string, PendingCapture>()

// Username typed on an earlier full-navigation step of a multi-step login, kept so
// the password-only page that follows can be captured against the right account.
// Keyed by registrable domain, TTL'd, never persisted, cleared on lock. A username
// is not a secret like the password, but we still hold it only while unlocked.
const rememberedUsernames = new Map<string, { username: string; ts: number }>()

// Sign-up forms: the id of the entry we provisionally saved when we generated+filled
// a password in a tab, so a later submit-capture in that tab CONFIRMS it (and adopts
// a then-typed username) instead of creating a duplicate. Memory-only, cleared on lock.
const provisionalByTab = new Map<number, string>()

/** Registrable-domain key for the pending map, with a hostname fallback. */
function pendingKey(hostname: string): string {
  return registrableDomain(hostname) || hostname
}

function lock(): void {
  sessionKey = null
  pending.clear() // captured plaintext must not outlive the unlocked session
  rememberedUsernames.clear()
  provisionalByTab.clear()
  chrome.alarms.clear(AUTO_LOCK_ALARM)
}

function armAutoLock(): void {
  chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: Math.max(1, settings.autoLockMinutes) })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) lock()
})

// Drop a tab's provisional-entry pointer when the tab closes (the entry itself stays).
chrome.tabs.onRemoved.addListener((tabId) => provisionalByTab.delete(tabId))

/**
 * Find the pending capture a page should offer to save. First by registrable
 * domain (the common same-site / subdomain-redirect case). On a miss, fall back
 * to a capture from the *same tab* still inside the cross-host window — this is
 * the submit-on-host-A, land-on-host-B redirect — surfaced at most once so it
 * doesn't reappear on later unrelated navigation in that tab. Drops stale entries.
 */
function resolvePending(hostname: string, tabId?: number): PendingCapture | null {
  const now = Date.now()
  const key = pendingKey(hostname)
  const direct = pending.get(key)
  if (direct) {
    if (now - direct.ts > PENDING_TTL_MS) {
      pending.delete(key)
    } else {
      return direct
    }
  }
  if (tabId === undefined) return null
  for (const [k, p] of pending) {
    if (now - p.ts > PENDING_TTL_MS) {
      pending.delete(k)
      continue
    }
    if (p.tabId === tabId && !p.crossHostSurfaced && now - p.ts <= CROSS_HOST_WINDOW_MS) {
      p.crossHostSurfaced = true
      return p
    }
  }
  return null
}

async function requireData(): Promise<{ key: CryptoKey; data: VaultData }> {
  if (!sessionKey) throw new Error('Vault is locked')
  const data = await loadData(sessionKey)
  return { key: sessionKey, data }
}

async function handle(req: Request, tabId?: number): Promise<unknown> {
  switch (req.type) {
    case 'status': {
      const res: StatusResponse = { exists: await vaultExists(), unlocked: sessionKey !== null }
      return res
    }
    case 'create': {
      if (await vaultExists()) throw new Error('Vault already exists')
      sessionKey = await createVault(req.masterPassword)
      armAutoLock()
      return { unlocked: true }
    }
    case 'unlock': {
      const { key } = await unlockVault(req.masterPassword) // throws on wrong password
      sessionKey = key
      armAutoLock()
      return { unlocked: true }
    }
    case 'verifyMaster': {
      // Confirm the master password against the existing wraps without disturbing
      // the session. Used to gate revealing a saved password in the UI.
      if (!sessionKey) throw new Error('Vault is locked')
      try {
        await unlockVault(req.masterPassword) // throws on wrong password
        armAutoLock()
        return { valid: true }
      } catch {
        return { valid: false }
      }
    }
    case 'lock': {
      lock()
      return { unlocked: false }
    }
    case 'setupRecovery': {
      // Generates a fresh phrase and (re)wraps the vault key under it. Returns the
      // phrase to the popup exactly once for display; it is never persisted in plaintext.
      const phrase = await setupRecoveryPhrase(req.currentSecret)
      armAutoLock()
      return { phrase }
    }
    case 'hasRecovery': {
      return { hasRecovery: await hasRecoveryPhrase() }
    }
    case 'changeMaster': {
      // currentSecret may be the old master password or the recovery phrase.
      await changeMasterPassword(req.currentSecret, req.newMasterPassword)
      // Re-derive the session under the new password so the popup stays unlocked.
      const { key } = await unlockVault(req.newMasterPassword)
      sessionKey = key
      armAutoLock()
      return { unlocked: true }
    }
    case 'list': {
      const { data } = await requireData()
      armAutoLock()
      return data.entries
    }
    case 'add': {
      const { key, data } = await requireData()
      const entry = newEntry(req.entry)
      data.entries.push(entry)
      await saveData(key, data)
      armAutoLock()
      return entry
    }
    case 'update': {
      const { key, data } = await requireData()
      const idx = data.entries.findIndex((e) => e.id === req.entry.id)
      if (idx === -1) throw new Error('Entry not found')
      const updated: VaultEntry = { ...req.entry, updatedAt: Date.now() }
      data.entries[idx] = updated
      await saveData(key, data)
      armAutoLock()
      return updated
    }
    case 'delete': {
      const { key, data } = await requireData()
      data.entries = data.entries.filter((e) => e.id !== req.id)
      await saveData(key, data)
      armAutoLock()
      return { deleted: req.id }
    }
    case 'matchForHost': {
      const { data } = await requireData()
      armAutoLock()
      return matchEntries(data, req.hostname)
    }
    case 'matchesForHost': {
      // Metadata only — no passwords exposed to content scripts.
      // Returns locked:true (soft signal, not an error) so the caller can
      // distinguish "vault is locked" from "no matches for this host".
      if (!sessionKey) return { entries: [] as EntryMeta[], locked: true }
      const { data } = await requireData()
      armAutoLock()
      const matches = matchEntries(data, req.hostname)
      return {
        entries: matches.map(({ id, title, url, username }): EntryMeta => ({ id, title, url, username })),
        locked: false,
      }
    }
    case 'fillEntry': {
      // Full credentials for one entry by id. Vault must be unlocked.
      const { data } = await requireData()
      armAutoLock()
      const entry = data.entries.find((e) => e.id === req.id)
      if (!entry) throw new Error('Entry not found')
      return { username: entry.username, password: entry.password, name: entry.name }
    }
    case 'generateForFill': {
      // Pure RNG — no vault access needed, so it works regardless of lock state.
      return { password: generatePassword(DEFAULT_OPTIONS) }
    }
    case 'suggestEmails': {
      // Derived from existing entries; empty while locked (we won't decrypt to read).
      if (!sessionKey) return { emails: [] }
      const { data } = await requireData()
      armAutoLock()
      return { emails: suggestEmails(data) }
    }
    case 'provisionalSave': {
      // Proactively store the just-generated sign-up password as a provisional entry,
      // before the form is submitted. Needs an unlocked vault to encrypt; if locked we
      // can't save (the value still sits in the page form, same as capture-on-submit).
      if (!sessionKey) return { saved: false }
      const { key, data } = await requireData()
      const entry = newEntry({
        title: req.hostname,
        url: req.hostname,
        username: req.username,
        password: req.password,
        notes: '',
        provisional: true,
      })
      data.entries.push(entry)
      await saveData(key, data)
      if (tabId !== undefined) provisionalByTab.set(tabId, entry.id)
      armAutoLock()
      return { saved: true, id: entry.id }
    }
    case 'rememberUsername': {
      // Only hold this while unlocked (capture needs an unlocked vault anyway).
      if (!sessionKey || !req.username) return { ok: false }
      rememberedUsernames.set(pendingKey(req.hostname), { username: req.username, ts: Date.now() })
      return { ok: true }
    }
    case 'capturePending': {
      // Silently ignore when capture is disabled, or when locked — we can't
      // decrypt to compare, and we won't hold captured plaintext while locked.
      if (!settings.captureEnabled || !sessionKey) return { stored: false }
      // Cross-document multi-step: if this page had no username field, pair the one
      // remembered from the earlier step (same registrable domain, within TTL).
      let username = req.username
      if (!username) {
        const remembered = rememberedUsernames.get(pendingKey(req.hostname))
        if (remembered && Date.now() - remembered.ts <= PENDING_TTL_MS) username = remembered.username
      }
      const data = await loadData(sessionKey)
      // Reconcile a proactive sign-up save: if this tab has a provisional entry with
      // the same password, this submit confirms it (adopting a now-typed username)
      // rather than offering a duplicate. The credential was already safely stored.
      const provId = tabId !== undefined ? provisionalByTab.get(tabId) : undefined
      if (provId) {
        const idx = data.entries.findIndex((e) => e.id === provId)
        if (idx !== -1 && data.entries[idx].password === req.password) {
          data.entries[idx] = confirmProvisionalEntry(data.entries[idx], username)
          await saveData(sessionKey, data)
          provisionalByTab.delete(tabId!)
          pending.delete(pendingKey(req.hostname))
          armAutoLock()
          return { stored: false }
        }
      }
      const decision = captureDecision(data, req.hostname, username, req.password)
      const key = pendingKey(req.hostname)
      if (decision.kind === 'none') {
        pending.delete(key)
        return { stored: false }
      }
      pending.set(key, {
        hostname: req.hostname,
        username,
        password: req.password,
        action: decision.kind,
        id: decision.kind === 'update' ? decision.id : undefined,
        title: decision.kind === 'update' ? decision.title : undefined,
        ts: Date.now(),
        tabId,
        crossHostSurfaced: false,
      })
      armAutoLock()
      return { stored: true }
    }
    case 'pendingFor': {
      if (!sessionKey) return { action: 'none', hostname: req.hostname, username: '' } satisfies PendingInfo
      const p = resolvePending(req.hostname, tabId)
      if (!p) return { action: 'none', hostname: req.hostname, username: '' } satisfies PendingInfo
      return {
        action: p.action,
        hostname: p.hostname,
        username: p.username,
        title: p.title,
      } satisfies PendingInfo
    }
    case 'captureConfirm': {
      const p = pending.get(pendingKey(req.hostname))
      if (!p) throw new Error('Nothing to save')
      const { key, data } = await requireData()
      if (p.action === 'save') {
        data.entries.push(
          newEntry({ title: p.hostname, url: p.hostname, username: p.username, password: p.password, notes: '' }),
        )
      } else {
        const idx = data.entries.findIndex((e) => e.id === p.id)
        if (idx !== -1) {
          data.entries[idx] = { ...data.entries[idx], password: p.password, updatedAt: Date.now() }
        }
      }
      await saveData(key, data)
      pending.delete(pendingKey(req.hostname))
      armAutoLock()
      return { saved: true }
    }
    case 'captureDismiss': {
      pending.delete(pendingKey(req.hostname))
      return { dismissed: true }
    }
    case 'biometricInfo': {
      // Safe while locked — only reads the non-secret credential id from storage.
      return { credentialId: await getBiometricCredentialId() }
    }
    case 'addBiometric': {
      await addBiometricWrap(req.currentSecret, fromBase64(req.prfOutput), req.credentialId)
      armAutoLock()
      return { ok: true }
    }
    case 'unlockBiometric': {
      const { key } = await unlockWithBiometric(fromBase64(req.prfOutput)) // throws on wrong PRF
      sessionKey = key
      armAutoLock()
      return { unlocked: true }
    }
    case 'removeBiometric': {
      if (!sessionKey) throw new Error('Unlock the vault first')
      await removeBiometricWrap()
      return { removed: true }
    }
    case 'exportVault': {
      // Encrypt the live entries under the export password; plaintext never leaves here.
      const { data } = await requireData()
      const json = await encryptExport(data, req.exportPassword)
      armAutoLock()
      return { json }
    }
    case 'importVault': {
      const { key, data } = await requireData()
      const incoming = await decryptImport(req.json, req.exportPassword) // throws on bad file/pw
      const { entries, added } = mergeEntries(data.entries, incoming.entries)
      data.entries = entries
      await saveData(key, data)
      armAutoLock()
      return { added }
    }
    case 'deleteVault': {
      await clearVault()
      lock()
      return { deleted: true }
    }
    case 'openPopup': {
      if (req.prefillHostname) {
        await chrome.storage.session.set({ p123_addEntry: req.prefillHostname })
      }
      try {
        await chrome.action.openPopup()
      } catch {
        // chrome.action.openPopup() requires Chrome 127+ and a user gesture chain;
        // silently ignore on older Chrome — user can still click the toolbar icon.
      }
      return { ok: true }
    }
  }
}

chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse) => {
  handle(req, sender.tab?.id)
    .then((data) => sendResponse({ ok: true, data } satisfies Response))
    .catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Response),
    )
  return true // keep the channel open for the async response
})
