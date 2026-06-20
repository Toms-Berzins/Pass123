import './popup.css'
import { sendMessage, type StatusResponse } from '../lib/messages'
import type { VaultEntry } from '../lib/vault'
import {
  DEFAULT_OPTIONS,
  entropyBits,
  generatePassword,
  poolSize,
  strengthFromEntropy,
  type GeneratorOptions,
} from '../lib/generator'
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from '../lib/settings'

const app = document.getElementById('app') as HTMLElement
const lockBtn = document.getElementById('lockBtn') as HTMLButtonElement

let genOptions: GeneratorOptions = { ...DEFAULT_OPTIONS }
let lastGenerated = ''
let settingsCache: Settings = { ...DEFAULT_SETTINGS }

lockBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'lock' })
  void route()
})

/** Decide which view to show based on whether a vault exists and is unlocked. */
async function route(): Promise<void> {
  const res = await sendMessage<StatusResponse>({ type: 'status' })
  if (!res.ok) return renderError(res.error)
  const { exists, unlocked } = res.data
  lockBtn.hidden = !unlocked
  if (!exists) return renderSetup()
  if (!unlocked) return renderUnlock()
  settingsCache = await getSettings()
  return renderMain()
}

// ---------- Setup (first run) ----------
function renderSetup(): void {
  app.innerHTML = `
    <p class="hint">Create a master password. It encrypts your vault and is never stored — if you forget it, the vault cannot be recovered.</p>
    <div>
      <label for="mp">Master password</label>
      <input id="mp" type="password" autocomplete="new-password" />
    </div>
    <div>
      <label for="mp2">Confirm</label>
      <input id="mp2" type="password" autocomplete="new-password" />
    </div>
    <p id="err" class="error"></p>
    <button id="create">Create vault</button>
  `
  const mp = byId<HTMLInputElement>('mp')
  const mp2 = byId<HTMLInputElement>('mp2')
  const err = byId<HTMLParagraphElement>('err')
  byId<HTMLButtonElement>('create').addEventListener('click', async () => {
    if (mp.value.length < 8) return (err.textContent = 'Use at least 8 characters.')
    if (mp.value !== mp2.value) return (err.textContent = 'Passwords do not match.')
    const res = await sendMessage({ type: 'create', masterPassword: mp.value })
    if (!res.ok) return (err.textContent = res.error)
    void route()
  })
  mp.focus()
}

// ---------- Unlock ----------
function renderUnlock(): void {
  app.innerHTML = `
    <div>
      <label for="mp">Master password</label>
      <input id="mp" type="password" autocomplete="current-password" />
    </div>
    <p id="err" class="error"></p>
    <button id="unlock">Unlock</button>
  `
  const mp = byId<HTMLInputElement>('mp')
  const err = byId<HTMLParagraphElement>('err')
  const submit = async () => {
    const res = await sendMessage({ type: 'unlock', masterPassword: mp.value })
    if (!res.ok) return (err.textContent = 'Wrong master password.')
    void route()
  }
  byId<HTMLButtonElement>('unlock').addEventListener('click', submit)
  mp.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
  mp.focus()
}

// ---------- Main (tabs: Generate / Vault / Settings) ----------
type Tab = 'gen' | 'vault' | 'settings'

function renderMain(tab: Tab = 'gen'): void {
  app.innerHTML = `
    <div class="tabs">
      <button data-tab="gen" class="${tab === 'gen' ? 'active' : ''}">Generate</button>
      <button data-tab="vault" class="${tab === 'vault' ? 'active' : ''}">Vault</button>
      <button data-tab="settings" class="${tab === 'settings' ? 'active' : ''}">Settings</button>
    </div>
    <div id="view"></div>
  `
  for (const b of app.querySelectorAll<HTMLButtonElement>('.tabs button')) {
    b.addEventListener('click', () => renderMain(b.dataset.tab as Tab))
  }
  if (tab === 'gen') renderGenerator()
  else if (tab === 'vault') void renderVault()
  else renderSettings()
}

function renderGenerator(): void {
  const view = byId<HTMLDivElement>('view')
  view.innerHTML = `
    <div class="gen-output" id="out">${lastGenerated || '—'}</div>
    <div class="meter"><span id="meter"></span></div>
    <p class="hint" id="entropy"></p>
    <div class="row">
      <button id="regen">Generate</button>
      <button id="copy" class="ghost">Copy</button>
    </div>
    <div>
      <label for="len">Length: <b id="lenVal">${genOptions.length}</b></label>
      <input id="len" type="range" min="8" max="64" value="${genOptions.length}" style="width:100%" />
    </div>
    <div class="checks">
      ${checkbox('lowercase', 'a-z')}
      ${checkbox('uppercase', 'A-Z')}
      ${checkbox('numbers', '0-9')}
      ${checkbox('symbols', '!@#')}
      ${checkbox('excludeAmbiguous', 'No l1O0')}
    </div>
    <button id="saveGen" class="ghost small">Save to vault →</button>
  `
  const out = byId<HTMLDivElement>('out')
  const len = byId<HTMLInputElement>('len')
  const lenVal = byId<HTMLElement>('lenVal')

  const refresh = () => {
    try {
      lastGenerated = generatePassword(genOptions)
      out.textContent = lastGenerated
      const bits = entropyBits(genOptions.length, poolSize(genOptions))
      const s = strengthFromEntropy(bits)
      const meter = byId<HTMLSpanElement>('meter')
      meter.className = `s-${s}`
      meter.style.width = `${Math.min(100, (bits / 128) * 100)}%`
      byId<HTMLParagraphElement>('entropy').textContent = `~${bits} bits • ${s}`
    } catch (e) {
      out.textContent = (e as Error).message
    }
  }

  len.addEventListener('input', () => {
    genOptions.length = Number(len.value)
    lenVal.textContent = len.value
    refresh()
  })
  for (const key of ['lowercase', 'uppercase', 'numbers', 'symbols', 'excludeAmbiguous'] as const) {
    byId<HTMLInputElement>(`chk-${key}`).addEventListener('change', (e) => {
      genOptions[key] = (e.target as HTMLInputElement).checked
      refresh()
    })
  }
  byId<HTMLButtonElement>('regen').addEventListener('click', refresh)
  byId<HTMLButtonElement>('copy').addEventListener('click', () => copySecret(lastGenerated))
  byId<HTMLButtonElement>('saveGen').addEventListener('click', () => renderEntryForm(undefined, lastGenerated))

  if (!lastGenerated) refresh()
  else refresh()
}

async function renderVault(): Promise<void> {
  const view = byId<HTMLDivElement>('view')
  const res = await sendMessage<VaultEntry[]>({ type: 'list' })
  if (!res.ok) return renderError(res.error)
  const entries = res.data

  view.innerHTML = `
    <div class="spread">
      <input id="search" type="text" placeholder="Search…" style="flex:1" />
      <button id="addBtn" class="small" style="margin-left:8px">+ Add</button>
    </div>
    <div class="list" id="list"></div>
  `
  byId<HTMLButtonElement>('addBtn').addEventListener('click', () => renderEntryForm())
  const search = byId<HTMLInputElement>('search')
  const list = byId<HTMLDivElement>('list')

  const draw = (q: string) => {
    const filtered = entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.url.toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q),
    )
    if (filtered.length === 0) {
      list.innerHTML = `<p class="empty">${entries.length ? 'No matches.' : 'No saved passwords yet.'}</p>`
      return
    }
    list.innerHTML = ''
    for (const e of filtered) list.appendChild(entryCard(e))
  }
  search.addEventListener('input', () => draw(search.value.toLowerCase().trim()))
  draw('')
}

function entryCard(e: VaultEntry): HTMLElement {
  const el = document.createElement('div')
  el.className = 'entry'
  el.innerHTML = `
    <div class="spread">
      <span class="title">${escapeHtml(e.title || e.url || 'Untitled')}</span>
      <div class="row" style="flex:0 0 auto;gap:4px">
        <button class="ghost small" data-act="copyUser">User</button>
        <button class="small" data-act="copyPass">Copy</button>
      </div>
    </div>
    <span class="sub">${escapeHtml(e.username)}${e.url ? ' • ' + escapeHtml(e.url) : ''}</span>
    <div class="row" style="gap:4px">
      <button class="ghost small" data-act="fill">Autofill</button>
      <button class="ghost small" data-act="edit">Edit</button>
      <button class="danger small" data-act="del">Delete</button>
    </div>
  `
  el.querySelector('[data-act="copyUser"]')!.addEventListener('click', () => copySecret(e.username))
  el.querySelector('[data-act="copyPass"]')!.addEventListener('click', () => copySecret(e.password))
  el.querySelector('[data-act="fill"]')!.addEventListener('click', () => autofill(e))
  el.querySelector('[data-act="edit"]')!.addEventListener('click', () => renderEntryForm(e))
  el.querySelector('[data-act="del"]')!.addEventListener('click', async () => {
    await sendMessage({ type: 'delete', id: e.id })
    void renderVault()
  })
  return el
}

function renderEntryForm(existing?: VaultEntry, presetPassword = ''): void {
  const view = byId<HTMLDivElement>('view')
  const e = existing
  view.innerHTML = `
    <div><label>Title</label><input id="f-title" type="text" value="${attr(e?.title)}" /></div>
    <div><label>URL</label><input id="f-url" type="text" placeholder="example.com" value="${attr(e?.url)}" /></div>
    <div><label>Username</label><input id="f-user" type="text" value="${attr(e?.username)}" /></div>
    <div><label>Password</label>
      <div class="row">
        <input id="f-pass" type="text" value="${attr(e?.password ?? presetPassword)}" />
        <button id="f-gen" class="ghost small" style="flex:0 0 auto">⟳</button>
      </div>
    </div>
    <div><label>Notes</label><textarea id="f-notes">${escapeHtml(e?.notes ?? '')}</textarea></div>
    <p id="err" class="error"></p>
    <div class="row">
      <button id="save">${e ? 'Update' : 'Save'}</button>
      <button id="cancel" class="ghost">Cancel</button>
    </div>
  `
  byId<HTMLButtonElement>('f-gen').addEventListener('click', () => {
    byId<HTMLInputElement>('f-pass').value = generatePassword(genOptions)
  })
  byId<HTMLButtonElement>('cancel').addEventListener('click', () => renderMain('vault'))
  byId<HTMLButtonElement>('save').addEventListener('click', async () => {
    const payload = {
      title: byId<HTMLInputElement>('f-title').value.trim(),
      url: byId<HTMLInputElement>('f-url').value.trim(),
      username: byId<HTMLInputElement>('f-user').value.trim(),
      password: byId<HTMLInputElement>('f-pass').value,
      notes: byId<HTMLTextAreaElement>('f-notes').value,
    }
    if (!payload.title && !payload.url) {
      return (byId<HTMLParagraphElement>('err').textContent = 'Add a title or URL.')
    }
    const res = e
      ? await sendMessage({ type: 'update', entry: { ...e, ...payload } })
      : await sendMessage({ type: 'add', entry: payload })
    if (!res.ok) return (byId<HTMLParagraphElement>('err').textContent = res.error)
    renderMain('vault')
  })
}

// ---------- Settings ----------
function renderSettings(): void {
  const view = byId<HTMLDivElement>('view')
  const s = settingsCache
  view.innerHTML = `
    <div>
      <label for="set-lock">Auto-lock after (minutes)</label>
      <input id="set-lock" type="number" min="1" max="240" value="${s.autoLockMinutes}" />
    </div>
    <label class="check" style="margin-top:4px">
      <input id="set-capture" type="checkbox" ${s.captureEnabled ? 'checked' : ''} />
      Offer to save passwords after login
    </label>
    <div>
      <label for="set-clip">Clear clipboard after (seconds, 0 = never)</label>
      <input id="set-clip" type="number" min="0" max="600" value="${s.clipboardClearSeconds}" />
    </div>
    <p id="set-status" class="hint"></p>

    <hr style="border:none;border-top:1px solid var(--border);margin:6px 0" />
    <label style="color:var(--danger)">Danger zone</label>
    <button id="del-vault" class="danger">Delete vault…</button>
    <p class="hint">Permanently erases all saved passwords. This cannot be undone.</p>
  `

  const status = byId<HTMLParagraphElement>('set-status')
  const apply = async (patch: Partial<Settings>) => {
    settingsCache = await saveSettings(patch)
    status.textContent = 'Saved.'
    setTimeout(() => (status.textContent = ''), 1500)
  }
  byId<HTMLInputElement>('set-lock').addEventListener('change', (e) =>
    apply({ autoLockMinutes: Number((e.target as HTMLInputElement).value) }),
  )
  byId<HTMLInputElement>('set-capture').addEventListener('change', (e) =>
    apply({ captureEnabled: (e.target as HTMLInputElement).checked }),
  )
  byId<HTMLInputElement>('set-clip').addEventListener('change', (e) =>
    apply({ clipboardClearSeconds: Number((e.target as HTMLInputElement).value) }),
  )

  // Two-step delete to avoid an accidental wipe.
  const del = byId<HTMLButtonElement>('del-vault')
  let armed = false
  del.addEventListener('click', async () => {
    if (!armed) {
      armed = true
      del.textContent = 'Click again to permanently delete'
      setTimeout(() => {
        armed = false
        del.textContent = 'Delete vault…'
      }, 4000)
      return
    }
    await sendMessage({ type: 'deleteVault' })
    void route()
  })
}

// ---------- helpers ----------
async function autofill(e: VaultEntry): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'fillCredentials',
      username: e.username,
      password: e.password,
    })
    window.close()
  } catch {
    /* content script not present on this page (e.g. chrome:// pages) */
  }
}

async function copySecret(value: string): Promise<void> {
  if (!value) return
  await navigator.clipboard.writeText(value)
  // Best-effort clipboard auto-clear after the configured delay (0 = never).
  const secs = settingsCache.clipboardClearSeconds
  if (secs > 0) {
    setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), secs * 1000)
  }
}

function checkbox(key: keyof GeneratorOptions, label: string): string {
  return `<label class="check"><input type="checkbox" id="chk-${key}" ${
    genOptions[key] ? 'checked' : ''
  } /> ${label}</label>`
}

function renderError(msg: string): void {
  app.innerHTML = `<p class="error">${escapeHtml(msg)}</p><button id="retry" class="ghost">Retry</button>`
  byId<HTMLButtonElement>('retry').addEventListener('click', () => void route())
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}
function attr(s: string | undefined): string {
  return escapeHtml(s ?? '').replace(/"/g, '&quot;')
}

void route()
