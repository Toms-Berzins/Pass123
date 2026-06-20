import './popup.css'
import { sendMessage, type StatusResponse } from '../lib/messages'
import type { VaultEntry } from '../lib/vault'
import {
  DEFAULT_OPTIONS,
  DEFAULT_PASSPHRASE,
  entropyBits,
  generatePassphrase,
  generatePassword,
  passphraseEntropyBits,
  poolSize,
  strengthFromEntropy,
  type GeneratorOptions,
  type PassphraseOptions,
} from '../lib/generator'
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from '../lib/settings'

const app = document.getElementById('app') as HTMLElement
const lockBtn = document.getElementById('lockBtn') as HTMLButtonElement

let genOptions: GeneratorOptions = { ...DEFAULT_OPTIONS }
let passOptions: PassphraseOptions = { ...DEFAULT_PASSPHRASE }
let genMode: 'password' | 'passphrase' = 'password'
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
    // Straight into recovery-phrase setup — the only moment we hold the password
    // and can wrap the vault key under a freshly minted phrase.
    void renderRecovery(mp.value, { firstRun: true })
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
    <button id="useRecovery" class="link" style="margin-top:8px">Forgot it? Use your recovery phrase</button>
  `
  const mp = byId<HTMLInputElement>('mp')
  const err = byId<HTMLParagraphElement>('err')
  const submit = async () => {
    const res = await sendMessage({ type: 'unlock', masterPassword: mp.value })
    if (!res.ok) return (err.textContent = 'Wrong master password.')
    void route()
  }
  byId<HTMLButtonElement>('unlock').addEventListener('click', submit)
  byId<HTMLButtonElement>('useRecovery').addEventListener('click', renderRecoverWithPhrase)
  mp.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
  mp.focus()
}

// ---------- Recovery phrase: onboarding / regenerate ----------
interface RecoveryOpts {
  firstRun?: boolean
}

/**
 * Show a freshly generated BIP39 recovery phrase for the user to record.
 * `currentSecret` (the master password, or a re-entered one in Settings) is needed
 * once to wrap the vault key under the new phrase; it never leaves this call.
 */
async function renderRecovery(currentSecret: string, opts: RecoveryOpts = {}): Promise<void> {
  lockBtn.hidden = true
  app.innerHTML = `<p class="hint">Generating recovery phrase…</p>`
  const res = await sendMessage<{ phrase: string }>({ type: 'setupRecovery', currentSecret })
  if (!res.ok) return renderError(res.error)

  let phrase = res.data.phrase
  const draw = () => {
    const cells = phrase
      .split(' ')
      .map((w, i) => `<div class="mword"><span class="n">${i + 1}</span><span class="w">${escapeHtml(w)}</span></div>`)
      .join('')
    app.innerHTML = `
      <h1 style="font-size:15px;margin:0">Your recovery phrase</h1>
      <p class="hint">These 12 words can restore your vault if you forget your master password. Write them down in order and keep them somewhere safe and offline.</p>
      <div class="mnemonic-grid">${cells}</div>
      <div class="row">
        <button id="rec-copy" class="ghost small">Copy</button>
        <button id="rec-print" class="ghost small">Print</button>
        <button id="rec-download" class="ghost small">Download</button>
        <button id="rec-regen" class="ghost small">Regenerate</button>
      </div>
      <p class="warn">If you lose <b>both</b> your master password and this phrase, your vault cannot be recovered — there is no server and no backdoor.</p>
      <label class="check"><input id="rec-saved" type="checkbox" /> I've written down my recovery phrase</label>
      <p id="err" class="error"></p>
      <button id="rec-done" disabled>${opts.firstRun ? 'Finish setup' : 'Done'}</button>
    `
    const done = byId<HTMLButtonElement>('rec-done')
    byId<HTMLInputElement>('rec-saved').addEventListener('change', (e) => {
      done.disabled = !(e.target as HTMLInputElement).checked
    })
    byId<HTMLButtonElement>('rec-copy').addEventListener('click', () => copySecret(phrase))
    byId<HTMLButtonElement>('rec-print').addEventListener('click', () => openEmergencyKit(phrase, 'print'))
    byId<HTMLButtonElement>('rec-download').addEventListener('click', () => openEmergencyKit(phrase, 'download'))
    byId<HTMLButtonElement>('rec-regen').addEventListener('click', async () => {
      const r = await sendMessage<{ phrase: string }>({ type: 'setupRecovery', currentSecret })
      if (!r.ok) return (byId<HTMLParagraphElement>('err').textContent = r.error)
      phrase = r.data.phrase
      draw()
    })
    done.addEventListener('click', () => {
      if (opts.firstRun) return void route()
      lockBtn.hidden = false // restore the header lock button hidden during this screen
      renderMain('settings')
    })
  }
  draw()
}

/** Unlock using the recovery phrase, then force setting a new master password. */
function renderRecoverWithPhrase(): void {
  app.innerHTML = `
    <p class="hint">Enter your 12-word recovery phrase to regain access. You'll set a new master password next.</p>
    <div><label for="phrase">Recovery phrase</label><textarea id="phrase" rows="3" placeholder="word1 word2 …"></textarea></div>
    <p id="err" class="error"></p>
    <div class="row">
      <button id="recover">Recover</button>
      <button id="back" class="ghost">Back</button>
    </div>
  `
  const phrase = byId<HTMLTextAreaElement>('phrase')
  const err = byId<HTMLParagraphElement>('err')
  byId<HTMLButtonElement>('back').addEventListener('click', renderUnlock)
  byId<HTMLButtonElement>('recover').addEventListener('click', async () => {
    const value = phrase.value.trim()
    if (!value) return (err.textContent = 'Enter your recovery phrase.')
    const res = await sendMessage({ type: 'unlock', masterPassword: value })
    if (!res.ok) return (err.textContent = 'That recovery phrase did not match.')
    renderSetNewMaster(value)
  })
  phrase.focus()
}

/** Set a new master password after a successful recovery (or password change). */
function renderSetNewMaster(currentSecret: string): void {
  app.innerHTML = `
    <p class="hint">Choose a new master password. It replaces the old one; your recovery phrase still works.</p>
    <div><label for="np">New master password</label><input id="np" type="password" autocomplete="new-password" /></div>
    <div><label for="np2">Confirm</label><input id="np2" type="password" autocomplete="new-password" /></div>
    <p id="err" class="error"></p>
    <button id="setpw">Set master password</button>
  `
  const np = byId<HTMLInputElement>('np')
  const np2 = byId<HTMLInputElement>('np2')
  const err = byId<HTMLParagraphElement>('err')
  byId<HTMLButtonElement>('setpw').addEventListener('click', async () => {
    if (np.value.length < 8) return (err.textContent = 'Use at least 8 characters.')
    if (np.value !== np2.value) return (err.textContent = 'Passwords do not match.')
    const res = await sendMessage({ type: 'changeMaster', currentSecret, newMasterPassword: np.value })
    if (!res.ok) return (err.textContent = res.error)
    void route()
  })
  np.focus()
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
    <div class="tabs" style="margin-bottom:2px">
      <button id="mode-password" class="${genMode === 'password' ? 'active' : ''}">Password</button>
      <button id="mode-passphrase" class="${genMode === 'passphrase' ? 'active' : ''}">Passphrase</button>
    </div>
    <div class="gen-output" id="out">${lastGenerated || '—'}</div>
    <div class="meter"><span id="meter"></span></div>
    <p class="hint" id="entropy"></p>
    <div class="row">
      <button id="regen">Generate</button>
      <button id="copy" class="ghost">Copy</button>
    </div>
    <div id="controls"></div>
    <button id="saveGen" class="ghost small">Save to vault →</button>
  `
  const out = byId<HTMLDivElement>('out')
  const meter = byId<HTMLSpanElement>('meter')

  const refresh = () => {
    try {
      let bits: number
      if (genMode === 'password') {
        lastGenerated = generatePassword(genOptions)
        bits = entropyBits(genOptions.length, poolSize(genOptions))
      } else {
        lastGenerated = generatePassphrase(passOptions)
        bits = passphraseEntropyBits(passOptions)
      }
      out.textContent = lastGenerated
      const s = strengthFromEntropy(bits)
      meter.className = `s-${s}`
      meter.style.width = `${Math.min(100, (bits / 128) * 100)}%`
      byId<HTMLParagraphElement>('entropy').textContent = `~${bits} bits • ${s}`
    } catch (e) {
      out.textContent = (e as Error).message
    }
  }

  const drawControls = () => {
    const controls = byId<HTMLDivElement>('controls')
    if (genMode === 'password') {
      controls.innerHTML = `
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
      `
      const len = byId<HTMLInputElement>('len')
      const lenVal = byId<HTMLElement>('lenVal')
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
    } else {
      const sep = passOptions.separator
      controls.innerHTML = `
        <div>
          <label for="words">Words: <b id="wordsVal">${passOptions.words}</b></label>
          <input id="words" type="range" min="3" max="10" value="${passOptions.words}" style="width:100%" />
        </div>
        <div>
          <label for="sep">Separator</label>
          <select id="sep">
            ${[['-', 'hyphen -'], ['.', 'dot .'], [' ', 'space'], ['_', 'underscore _'], ['', 'none']]
              .map(([v, t]) => `<option value="${attr(v)}" ${v === sep ? 'selected' : ''}>${t}</option>`)
              .join('')}
          </select>
        </div>
        <div class="checks">
          <label class="check"><input type="checkbox" id="pp-capitalize" ${passOptions.capitalize ? 'checked' : ''} /> Capitalize</label>
          <label class="check"><input type="checkbox" id="pp-includeNumber" ${passOptions.includeNumber ? 'checked' : ''} /> Add a digit</label>
        </div>
      `
      const words = byId<HTMLInputElement>('words')
      const wordsVal = byId<HTMLElement>('wordsVal')
      words.addEventListener('input', () => {
        passOptions.words = Number(words.value)
        wordsVal.textContent = words.value
        refresh()
      })
      byId<HTMLSelectElement>('sep').addEventListener('change', (e) => {
        passOptions.separator = (e.target as HTMLSelectElement).value
        refresh()
      })
      byId<HTMLInputElement>('pp-capitalize').addEventListener('change', (e) => {
        passOptions.capitalize = (e.target as HTMLInputElement).checked
        refresh()
      })
      byId<HTMLInputElement>('pp-includeNumber').addEventListener('change', (e) => {
        passOptions.includeNumber = (e.target as HTMLInputElement).checked
        refresh()
      })
    }
  }

  const setMode = (mode: 'password' | 'passphrase') => {
    genMode = mode
    byId<HTMLButtonElement>('mode-password').classList.toggle('active', mode === 'password')
    byId<HTMLButtonElement>('mode-passphrase').classList.toggle('active', mode === 'passphrase')
    drawControls()
    refresh()
  }
  byId<HTMLButtonElement>('mode-password').addEventListener('click', () => setMode('password'))
  byId<HTMLButtonElement>('mode-passphrase').addEventListener('click', () => setMode('passphrase'))
  byId<HTMLButtonElement>('regen').addEventListener('click', refresh)
  byId<HTMLButtonElement>('copy').addEventListener('click', () => copySecret(lastGenerated))
  byId<HTMLButtonElement>('saveGen').addEventListener('click', () => renderEntryForm(undefined, lastGenerated))

  drawControls()
  refresh()
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
    <label>Recovery phrase</label>
    <p id="rec-state" class="hint">Checking…</p>
    <div id="rec-action"></div>

    <hr style="border:none;border-top:1px solid var(--border);margin:6px 0" />
    <label>Backup &amp; restore</label>
    <p class="hint">An encrypted backup file you can store anywhere — protected by a separate export password.</p>
    <div class="row">
      <button id="export-btn" class="ghost small">Export…</button>
      <button id="import-btn" class="ghost small">Import…</button>
    </div>

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

  // Recovery phrase: regenerating re-wraps the vault key, so it needs the master
  // password re-entered (the background never keeps it around).
  void (async () => {
    const res = await sendMessage<{ hasRecovery: boolean }>({ type: 'hasRecovery' })
    const has = res.ok && res.data.hasRecovery
    byId<HTMLParagraphElement>('rec-state').textContent = has
      ? 'A recovery phrase is set. Regenerating replaces it — the old one stops working.'
      : 'No recovery phrase yet. Set one up so you can restore the vault if you forget your master password.'
    const action = byId<HTMLDivElement>('rec-action')
    const btn = document.createElement('button')
    btn.className = 'ghost small'
    btn.textContent = has ? 'Regenerate recovery phrase' : 'Set up recovery phrase'
    btn.addEventListener('click', () => promptForRecovery())
    action.appendChild(btn)
  })()

  byId<HTMLButtonElement>('export-btn').addEventListener('click', renderExport)
  byId<HTMLButtonElement>('import-btn').addEventListener('click', renderImport)

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

// ---------- Backup & restore ----------
/** Export the vault to an encrypted file protected by a user-chosen export password. */
function renderExport(): void {
  lockBtn.hidden = true
  app.innerHTML = `
    <p class="hint">Choose an export password. You'll need it to restore this backup — it is independent of your master password and is not stored.</p>
    <div><label for="ep">Export password</label><input id="ep" type="password" autocomplete="new-password" /></div>
    <div><label for="ep2">Confirm</label><input id="ep2" type="password" autocomplete="new-password" /></div>
    <p id="err" class="error"></p>
    <div class="row">
      <button id="do-export">Download backup</button>
      <button id="cancel" class="ghost">Cancel</button>
    </div>
  `
  const ep = byId<HTMLInputElement>('ep')
  const ep2 = byId<HTMLInputElement>('ep2')
  const err = byId<HTMLParagraphElement>('err')
  byId<HTMLButtonElement>('cancel').addEventListener('click', backToSettings)
  byId<HTMLButtonElement>('do-export').addEventListener('click', async () => {
    if (ep.value.length < 8) return (err.textContent = 'Use at least 8 characters.')
    if (ep.value !== ep2.value) return (err.textContent = 'Passwords do not match.')
    const res = await sendMessage<{ json: string }>({ type: 'exportVault', exportPassword: ep.value })
    if (!res.ok) return (err.textContent = res.error)
    downloadBlob(res.data.json, `pass123-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')
    backToSettings()
  })
  ep.focus()
}

/** Restore entries from an encrypted backup file, merging them into the current vault. */
function renderImport(): void {
  lockBtn.hidden = true
  app.innerHTML = `
    <p class="hint">Select a Pass123 backup file and enter the export password it was saved with. Entries are merged into your vault; duplicates are skipped.</p>
    <div><label for="file">Backup file</label><input id="file" type="file" accept="application/json,.json" /></div>
    <div><label for="ip">Export password</label><input id="ip" type="password" autocomplete="current-password" /></div>
    <p id="err" class="error"></p>
    <div class="row">
      <button id="do-import">Import</button>
      <button id="cancel" class="ghost">Cancel</button>
    </div>
  `
  const file = byId<HTMLInputElement>('file')
  const ip = byId<HTMLInputElement>('ip')
  const err = byId<HTMLParagraphElement>('err')
  byId<HTMLButtonElement>('cancel').addEventListener('click', backToSettings)
  byId<HTMLButtonElement>('do-import').addEventListener('click', async () => {
    const f = file.files?.[0]
    if (!f) return (err.textContent = 'Choose a backup file.')
    if (!ip.value) return (err.textContent = 'Enter the export password.')
    const json = await f.text()
    const res = await sendMessage<{ added: number }>({ type: 'importVault', json, exportPassword: ip.value })
    if (!res.ok) return (err.textContent = res.error)
    err.className = 'hint'
    err.textContent = `Imported ${res.data.added} ${res.data.added === 1 ? 'entry' : 'entries'}.`
    setTimeout(backToSettings, 1200)
  })
  file.focus()
}

function backToSettings(): void {
  lockBtn.hidden = false
  renderMain('settings')
}

/** Confirm the master password before (re)generating a recovery phrase from Settings. */
function promptForRecovery(): void {
  app.innerHTML = `
    <p class="hint">Confirm your master password to generate a recovery phrase.</p>
    <div><label for="cmp">Master password</label><input id="cmp" type="password" autocomplete="current-password" /></div>
    <p id="err" class="error"></p>
    <div class="row">
      <button id="go">Continue</button>
      <button id="cancel" class="ghost">Cancel</button>
    </div>
  `
  const cmp = byId<HTMLInputElement>('cmp')
  const err = byId<HTMLParagraphElement>('err')
  byId<HTMLButtonElement>('cancel').addEventListener('click', () => renderMain('settings'))
  const go = async () => {
    // Verify the password resolves a wrap before showing the phrase screen.
    const check = await sendMessage({ type: 'unlock', masterPassword: cmp.value })
    if (!check.ok) return (err.textContent = 'Wrong master password.')
    void renderRecovery(cmp.value)
  }
  byId<HTMLButtonElement>('go').addEventListener('click', go)
  cmp.addEventListener('keydown', (e) => e.key === 'Enter' && go())
  cmp.focus()
}

/**
 * Build a self-contained printable "emergency kit" (recovery phrase + instructions)
 * and either open it in a tab for printing or download it as an .html file. Kept off
 * the network entirely — it's a local Blob URL.
 */
function openEmergencyKit(phrase: string, mode: 'print' | 'download'): void {
  const cells = phrase
    .split(' ')
    .map((w, i) => `<td><span class="n">${i + 1}.</span> ${escapeHtml(w)}</td>`)
    .map((c, i) => (i % 3 === 0 ? '<tr>' + c : i % 3 === 2 ? c + '</tr>' : c))
    .join('')
  const html = `<!doctype html><html><head><meta charset="utf-8" />
  <title>Pass123 Emergency Kit</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #111; }
    h1 { font-size: 22px; } .sub { color: #555; }
    table { border-collapse: collapse; width: 100%; margin: 20px 0; }
    td { border: 1px solid #ccc; padding: 10px 12px; font-family: ui-monospace, Menlo, monospace; font-size: 15px; width: 33%; }
    td .n { color: #888; font-size: 12px; }
    .warn { border: 1px solid #c70; background: #fff8ec; color: #944; padding: 12px; border-radius: 6px; font-size: 13px; }
    ol { font-size: 13px; color: #333; line-height: 1.6; }
  </style></head><body>
    <h1>Pass123 — Emergency Recovery Kit</h1>
    <p class="sub">Generated ${new Date().toLocaleDateString()}. Store this on paper, somewhere safe and offline.</p>
    <table>${cells}</table>
    <div class="warn"><b>Keep this secret.</b> Anyone with these 12 words can unlock your vault. If you lose both your master password and this phrase, your vault cannot be recovered — there is no server and no backdoor.</div>
    <h3>To restore your vault</h3>
    <ol>
      <li>Install the Pass123 extension and open it.</li>
      <li>On the unlock screen, choose <b>"Forgot it? Use your recovery phrase."</b></li>
      <li>Type these 12 words in order, then set a new master password.</li>
    </ol>
  </body></html>`

  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  if (mode === 'download') {
    const a = document.createElement('a')
    a.href = url
    a.download = 'Pass123-Emergency-Kit.html'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } else {
    // Open in its own tab so the user can print it; the popup can close freely.
    void chrome.tabs.create({ url })
  }
}

// ---------- helpers ----------
/** Trigger a browser download of `content` as a local file (never hits the network). */
function downloadBlob(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

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
