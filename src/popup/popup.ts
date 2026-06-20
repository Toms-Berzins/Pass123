import './popup.css'
import { sendMessage, type StatusResponse } from '../lib/messages'
import type { VaultEntry } from '../lib/vault'
import { rankMatches } from '../lib/urlmatch'
import {
  generateTOTP,
  isValidTOTPSecret,
  normalizeTOTPSecret,
  parseTOTPUri,
} from '../lib/totp'
import {
  enrollBiometric,
  getBiometricPRF,
  isPlatformAuthenticatorAvailable,
} from '../lib/webauthn'
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

/** Passphrase separator options, rendered as the square chip picker. */
const SEPARATORS: { value: string; glyph: string; label: string }[] = [
  { value: '-', glyph: '-', label: 'Hyphen' },
  { value: '.', glyph: '.', label: 'Dot' },
  { value: ' ', glyph: '␣', label: 'Space' },
  { value: '_', glyph: '_', label: 'Underscore' },
  { value: '', glyph: '∅', label: 'None' },
]

// One shared 1s ticker drives every visible TOTP display; entries unmounted from
// the DOM are dropped automatically so re-renders never leak intervals.
interface TotpDisplay {
  el: HTMLElement
  secret: string
  update: (code: string, remaining: number) => void
}
const totpDisplays = new Set<TotpDisplay>()
let totpTimer: number | null = null

function registerTotp(d: TotpDisplay): void {
  totpDisplays.add(d)
  void tickTotp()
  if (totpTimer === null) totpTimer = setInterval(() => void tickTotp(), 1000) as unknown as number
}

async function tickTotp(): Promise<void> {
  for (const d of totpDisplays) {
    if (!d.el.isConnected) {
      totpDisplays.delete(d)
      continue
    }
    try {
      const { code, remainingSeconds } = await generateTOTP({ secret: d.secret })
      d.update(code, remainingSeconds)
    } catch {
      d.el.textContent = 'bad TOTP secret'
    }
  }
  if (totpDisplays.size === 0 && totpTimer !== null) {
    clearInterval(totpTimer)
    totpTimer = null
  }
}

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
  return renderMain(await defaultTab())
}

/**
 * Land on the tab matching the user's intent: if there are saved logins for the
 * current site, open the Vault (with "For this site" pinned); otherwise Generate.
 */
async function defaultTab(): Promise<Tab> {
  try {
    const res = await sendMessage<VaultEntry[]>({ type: 'list' })
    if (!res.ok || res.data.length === 0) return 'gen'
    const host = await activeTabHostname()
    return host && rankMatches(res.data, host).length > 0 ? 'vault' : 'gen'
  } catch {
    return 'gen'
  }
}

// ---------- Setup (first run) ----------
function renderSetup(): void {
  app.innerHTML = `
    <p class="step">Step 1 of 2 · Create your vault</p>
    <p class="hint">Create a master password. It encrypts your vault and is never stored — if you forget it, the vault cannot be recovered.</p>
    <div>
      <label for="mp">Master password</label>
      <input id="mp" type="password" autocomplete="new-password" />
    </div>
    <div class="meter"><span id="mp-meter"></span></div>
    <p class="hint" id="mp-strength"></p>
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
  wireStrengthMeter(mp, byId<HTMLSpanElement>('mp-meter'), byId<HTMLParagraphElement>('mp-strength'))
  addRevealToggle(mp)
  const createBtn = byId<HTMLButtonElement>('create')
  const submit = () =>
    withPending(createBtn, 'Creating…', async () => {
      if (mp.value.length < 8) return void (err.textContent = 'Use at least 8 characters.')
      if (mp.value !== mp2.value) return void (err.textContent = 'Passwords do not match.')
      const res = await sendMessage({ type: 'create', masterPassword: mp.value })
      if (!res.ok) return void (err.textContent = res.error)
      // Straight into recovery-phrase setup — the only moment we hold the password
      // and can wrap the vault key under a freshly minted phrase.
      void renderRecovery(mp.value, { firstRun: true })
    })
  createBtn.addEventListener('click', submit)
  mp2.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
  mp.focus()
}

// ---------- Unlock ----------
function renderUnlock(): void {
  app.innerHTML = `
    <div class="lock-hero">
      <div class="lock-badge">${ICON.lock}</div>
      <p class="lock-sub">Enter your master password to unlock</p>
    </div>
    <div>
      <label for="mp">Master password</label>
      <input id="mp" type="password" autocomplete="current-password" />
    </div>
    <p id="err" class="error"></p>
    <button id="unlock">Unlock</button>
    <div id="bio-slot"></div>
    <button id="useRecovery" class="link" style="margin-top:8px">Forgot it? Use your recovery phrase</button>
  `
  const mp = byId<HTMLInputElement>('mp')
  const err = byId<HTMLParagraphElement>('err')
  addRevealToggle(mp)
  const unlockBtn = byId<HTMLButtonElement>('unlock')
  const submit = () =>
    withPending(unlockBtn, 'Unlocking…', async () => {
      const res = await sendMessage({ type: 'unlock', masterPassword: mp.value })
      if (!res.ok) return void (err.textContent = 'Wrong master password.')
      void route()
    })
  unlockBtn.addEventListener('click', submit)
  byId<HTMLButtonElement>('useRecovery').addEventListener('click', renderRecoverWithPhrase)
  mp.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
  mp.focus()

  // Offer biometric unlock if it's enrolled and a platform authenticator is present.
  void (async () => {
    const info = await sendMessage<{ credentialId: string | null }>({ type: 'biometricInfo' })
    if (!info.ok || !info.data.credentialId) return
    if (!(await isPlatformAuthenticatorAvailable())) return
    const credentialId = info.data.credentialId
    // The awaits above can outlive this screen (e.g. unlocked before they resolved),
    // leaving bio-slot detached — bail rather than write to a missing node.
    const slot = byId<HTMLDivElement>('bio-slot')
    if (!slot?.isConnected) return
    slot.innerHTML = `<button id="bioUnlock" class="ghost" style="margin-top:8px">Unlock with ${escapeHtml(biometricName())}</button>`
    byId<HTMLButtonElement>('bioUnlock').addEventListener('click', async () => {
      try {
        const prfOutput = await getBiometricPRF(credentialId)
        const res = await sendMessage({ type: 'unlockBiometric', prfOutput })
        if (!res.ok) return (err.textContent = 'Biometric unlock failed.')
        void route()
      } catch (e) {
        err.textContent = (e as Error).message
      }
    })
  })()
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
      ${opts.firstRun ? '<p class="step">Step 2 of 2 · Save your recovery phrase</p>' : ''}
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
    byId<HTMLButtonElement>('rec-copy').addEventListener('click', () => copySecret(phrase, 'Recovery phrase copied'))
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
    <div class="meter"><span id="np-meter"></span></div>
    <p class="hint" id="np-strength"></p>
    <div><label for="np2">Confirm</label><input id="np2" type="password" autocomplete="new-password" /></div>
    <p id="err" class="error"></p>
    <button id="setpw">Set master password</button>
  `
  const np = byId<HTMLInputElement>('np')
  const np2 = byId<HTMLInputElement>('np2')
  const err = byId<HTMLParagraphElement>('err')
  wireStrengthMeter(np, byId<HTMLSpanElement>('np-meter'), byId<HTMLParagraphElement>('np-strength'))
  addRevealToggle(np)
  const setBtn = byId<HTMLButtonElement>('setpw')
  const submit = () =>
    withPending(setBtn, 'Saving…', async () => {
      if (np.value.length < 8) return void (err.textContent = 'Use at least 8 characters.')
      if (np.value !== np2.value) return void (err.textContent = 'Passwords do not match.')
      const res = await sendMessage({ type: 'changeMaster', currentSecret, newMasterPassword: np.value })
      if (!res.ok) return void (err.textContent = res.error)
      void route()
    })
  setBtn.addEventListener('click', submit)
  np2.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
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
    <div class="tabs">
      <button id="mode-password" class="${genMode === 'password' ? 'active' : ''}">Password</button>
      <button id="mode-passphrase" class="${genMode === 'passphrase' ? 'active' : ''}">Passphrase</button>
    </div>
    <div class="gen-output">
      <span class="gen-output-text" id="out">${escapeHtml(lastGenerated) || '—'}</span>
      <div class="gen-output-actions">
        <button id="regenIcon" class="well-icon" title="Generate" aria-label="Generate new value">${ICON.refresh}</button>
        <button id="copyIcon" class="well-icon" title="Copy" aria-label="Copy to clipboard">${ICON.copy}</button>
      </div>
    </div>
    <div class="meter"><span id="meter"></span></div>
    <p class="hint" id="entropy"></p>
    <div id="controls"></div>
    <div class="row">
      <button id="regen">Generate</button>
      <button id="copy" class="ghost">Copy</button>
    </div>
    <button id="saveGen" class="link save-to-vault">Save to vault →</button>
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
      const detail = genMode === 'passphrase' ? ` • ${passOptions.words} words` : ''
      byId<HTMLParagraphElement>('entropy').textContent = `~${bits} bits • ${s}${detail}`
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
          <input id="len" class="slider" type="range" min="8" max="64" value="${genOptions.length}" />
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
      setSliderFill(len)
      len.addEventListener('input', () => {
        genOptions.length = Number(len.value)
        lenVal.textContent = len.value
        setSliderFill(len)
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
          <input id="words" class="slider" type="range" min="3" max="10" value="${passOptions.words}" />
        </div>
        <div class="spread">
          <label>Separator</label>
          <div class="seg-chips" id="sep" role="group" aria-label="Separator">
            ${SEPARATORS.map(
              (s) =>
                `<button type="button" class="seg-chip ${s.value === sep ? 'active' : ''}" data-sep="${attr(s.value)}" title="${attr(s.label)}" aria-label="${attr(s.label)}" aria-pressed="${s.value === sep}">${escapeHtml(s.glyph)}</button>`,
            ).join('')}
          </div>
        </div>
        <div class="checks">
          <label class="check"><input type="checkbox" id="pp-capitalize" ${passOptions.capitalize ? 'checked' : ''} /> Capitalize</label>
          <label class="check"><input type="checkbox" id="pp-includeNumber" ${passOptions.includeNumber ? 'checked' : ''} /> Add a digit</label>
        </div>
      `
      const words = byId<HTMLInputElement>('words')
      const wordsVal = byId<HTMLElement>('wordsVal')
      setSliderFill(words)
      words.addEventListener('input', () => {
        passOptions.words = Number(words.value)
        wordsVal.textContent = words.value
        setSliderFill(words)
        refresh()
      })
      const sepGroup = byId<HTMLDivElement>('sep')
      for (const chip of sepGroup.querySelectorAll<HTMLButtonElement>('.seg-chip')) {
        chip.addEventListener('click', () => {
          passOptions.separator = chip.dataset.sep ?? ''
          for (const c of sepGroup.querySelectorAll<HTMLButtonElement>('.seg-chip')) {
            const on = c === chip
            c.classList.toggle('active', on)
            c.setAttribute('aria-pressed', String(on))
          }
          refresh()
        })
      }
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
  const doCopy = () =>
    copySecret(lastGenerated, genMode === 'password' ? 'Password copied' : 'Passphrase copied')
  byId<HTMLButtonElement>('regen').addEventListener('click', refresh)
  byId<HTMLButtonElement>('regenIcon').addEventListener('click', refresh)
  byId<HTMLButtonElement>('copy').addEventListener('click', doCopy)
  byId<HTMLButtonElement>('copyIcon').addEventListener('click', doCopy)
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
      <div class="search-wrap">
        <input id="search" type="text" placeholder="Search…" />
        <button id="searchClear" class="search-clear" aria-label="Clear search" hidden>✕</button>
      </div>
      <button id="addBtn" class="small" style="margin-left:8px">+ Add</button>
    </div>
    <p id="count" class="result-count"></p>
    <div id="forSite"></div>
    <div class="list" id="list"></div>
  `
  byId<HTMLButtonElement>('addBtn').addEventListener('click', () => renderEntryForm())
  const search = byId<HTMLInputElement>('search')
  const clearBtn = byId<HTMLButtonElement>('searchClear')
  const count = byId<HTMLParagraphElement>('count')
  const list = byId<HTMLDivElement>('list')
  const forSite = byId<HTMLDivElement>('forSite')

  // Surface entries for the page the user is actually on, best match first.
  const host = await activeTabHostname()
  const siteMatches = host ? rankMatches(entries, host) : []

  const draw = (q: string) => {
    clearBtn.hidden = !q
    // The "for this site" section is a no-query convenience; hide it while searching.
    if (!q && siteMatches.length > 0) {
      forSite.innerHTML = `<p class="section-label">For this site${host ? ` · ${escapeHtml(host)}` : ''}</p>`
      for (const e of siteMatches) forSite.appendChild(entryCard(e))
    } else {
      forSite.innerHTML = ''
    }

    const filtered = entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.url.toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q),
    )
    count.textContent = q ? `${filtered.length} ${filtered.length === 1 ? 'match' : 'matches'}` : ''
    if (filtered.length === 0) {
      if (entries.length === 0) {
        list.innerHTML = `<div class="empty"><p style="margin:0 0 10px">No saved passwords yet.</p></div>`
        const cta = document.createElement('button')
        cta.className = 'small'
        cta.textContent = '+ Add your first password'
        cta.addEventListener('click', () => renderEntryForm())
        list.querySelector('.empty')!.appendChild(cta)
      } else {
        list.innerHTML = `<p class="empty">No matches.</p>`
      }
      return
    }
    list.innerHTML = q || siteMatches.length === 0 ? '' : `<p class="section-label">All passwords</p>`
    for (const e of filtered) list.appendChild(entryCard(e))
  }
  search.addEventListener('input', () => draw(search.value.toLowerCase().trim()))
  clearBtn.addEventListener('click', () => {
    search.value = ''
    draw('')
    search.focus()
  })
  draw('')
}

/** Hostname of the active tab, or '' for non-web pages (chrome://, etc.). */
async function activeTabHostname(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return tab?.url ? new URL(tab.url).hostname : ''
  } catch {
    return ''
  }
}

/** Two-letter badge initials from an entry's title/host (e.g. "github.com" → "GI"). */
function entryInitials(e: VaultEntry): string {
  const base = (e.title || e.url || '?').replace(/^https?:\/\//, '').replace(/^www\./, '')
  const letters = base.replace(/[^a-z0-9]/gi, '')
  return (letters.slice(0, 2) || '?').toUpperCase()
}

/** Coarse "Nd ago" relative time for the entry meta line. */
function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const min = 60_000, hour = 60 * min, day = 24 * hour
  if (diff < hour) return `${Math.max(1, Math.floor(diff / min))}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  const days = Math.floor(diff / day)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`
}

function entryCard(e: VaultEntry): HTMLElement {
  const el = document.createElement('div')
  el.className = 'entry'
  el.innerHTML = `
    <div class="entry-head" data-act="toggle">
      <div class="entry-icon">${escapeHtml(entryInitials(e))}</div>
      <div class="entry-headtext">
        <div class="entry-titlerow">
          <span class="title">${escapeHtml(e.title || e.url || 'Untitled')}</span>
          <span class="entry-tag">Login</span>
        </div>
        <div class="entry-meta">${e.url ? escapeHtml(e.url) + ' · ' : ''}updated ${escapeHtml(relativeTime(e.updatedAt))}</div>
      </div>
      <span class="well-icon entry-chevron">${ICON.chevron}</span>
    </div>
    <div class="entry-body">
      <div class="entry-fields">
        <div class="entry-field">
          <span class="field-label">User</span>
          <span class="field-val">${escapeHtml(e.username) || '<span style="opacity:.5">—</span>'}</span>
          <button class="field-icon" data-act="copyUser" title="Copy username" aria-label="Copy username">${ICON.copy}</button>
        </div>
        <div class="entry-field">
          <span class="field-label">Pass</span>
          <span class="field-val pass-val" data-pass>••••••••</span>
          <button class="field-icon" data-act="reveal" title="Reveal password" aria-label="Reveal password">${ICON.eyeOff}</button>
          <button class="field-icon" data-act="copyPass" title="Copy password" aria-label="Copy password">${ICON.copy}</button>
        </div>
      </div>
      ${e.totp ? totpRowHtml() : ''}
      <div class="entry-actions">
        <button class="small" data-act="fill">Autofill</button>
        <button class="ghost small" data-act="edit">Edit</button>
        <button class="danger small entry-del" data-act="del" title="Delete" aria-label="Delete">${ICON.trash}</button>
      </div>
    </div>
  `
  if (e.totp) mountTotpRow(el, e.totp)

  el.querySelector('.entry-head')!.addEventListener('click', () => el.classList.toggle('expanded'))

  // Inline password reveal, gated by the same master-password challenge as the form.
  const passEl = el.querySelector<HTMLElement>('[data-pass]')!
  const revealBtn = el.querySelector<HTMLButtonElement>('[data-act="reveal"]')!
  let needsVerify = Boolean(e.password)
  const setRevealed = (on: boolean): void => {
    passEl.textContent = on ? e.password || '—' : '••••••••'
    passEl.classList.toggle('revealed', on)
    revealBtn.innerHTML = on ? ICON.eye : ICON.eyeOff
    revealBtn.title = revealBtn.ariaLabel = on ? 'Hide password' : 'Reveal password'
  }
  revealBtn.addEventListener('click', async () => {
    if (passEl.classList.contains('revealed')) return setRevealed(false)
    if (needsVerify && !(await promptMasterVerify(el))) return
    needsVerify = false
    setRevealed(true)
  })

  el.querySelector('[data-act="copyUser"]')!.addEventListener('click', () => copySecret(e.username, 'Username copied'))
  el.querySelector('[data-act="copyPass"]')!.addEventListener('click', () => copySecret(e.password, 'Password copied'))
  el.querySelector('[data-act="fill"]')!.addEventListener('click', () => autofill(e))
  el.querySelector('[data-act="edit"]')!.addEventListener('click', () => renderEntryForm(e))
  el.querySelector('[data-act="del"]')!.addEventListener('click', async () => {
    await sendMessage({ type: 'delete', id: e.id })
    void renderVault()
    toast(`Deleted ${e.title || e.url || 'entry'}`, {
      danger: true,
      icon: '✕',
      action: {
        label: 'Undo',
        onClick: async () => {
          await sendMessage({
            type: 'add',
            entry: {
              title: e.title,
              url: e.url,
              username: e.username,
              password: e.password,
              notes: e.notes,
              totp: e.totp,
            },
          })
          void renderVault()
        },
      },
    })
  })
  return el
}

/** Markup for the live 2FA row inside an entry card. */
function totpRowHtml(): string {
  return `
    <div class="totp" data-totp>
      <span class="totp-label">2FA</span>
      <span class="totp-code" data-totp-code>••• •••</span>
      <span class="totp-left" data-totp-left></span>
      <button class="ghost small" data-act="copyTotp" style="flex:0 0 auto">Copy</button>
    </div>`
}

/** Wire an entry card's TOTP row into the shared ticker and copy button. */
function mountTotpRow(card: HTMLElement, secret: string): void {
  const row = card.querySelector<HTMLElement>('[data-totp]')!
  const codeEl = card.querySelector<HTMLElement>('[data-totp-code]')!
  const leftEl = card.querySelector<HTMLElement>('[data-totp-left]')!
  let current = ''
  registerTotp({
    el: row,
    secret,
    update: (code, remaining) => {
      current = code
      codeEl.textContent = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
      leftEl.textContent = `${remaining}s`
      leftEl.classList.toggle('expiring', remaining <= 5)
    },
  })
  card.querySelector('[data-act="copyTotp"]')!.addEventListener('click', () => copySecret(current, 'Code copied'))
}

function renderEntryForm(existing?: VaultEntry, presetPassword = ''): void {
  const view = byId<HTMLDivElement>('view')
  const e = existing
  view.innerHTML = `
    <div><label>Title</label><input id="f-title" type="text" value="${attr(e?.title)}" /></div>
    <div><label>URL</label><input id="f-url" type="text" placeholder="example.com" value="${attr(e?.url)}" /></div>
    <div><label>Username</label><input id="f-user" type="text" value="${attr(e?.username)}" /></div>
    <div id="f-pass-block"><label>Password</label>
      <div class="row" id="f-pass-row">
        <input id="f-pass" type="${e?.password ? 'password' : 'text'}" value="${attr(e?.password ?? presetPassword)}" />
        <button id="f-reveal" class="icon-btn" title="Reveal password" aria-label="Reveal password">${e?.password ? ICON.eye : ICON.eyeOff}</button>
        <button id="f-gen" class="icon-btn" title="Generate password" aria-label="Generate password">${ICON.refresh}</button>
      </div>
    </div>
    <div><label>2FA secret or otpauth:// URI <span class="hint">(optional)</span></label>
      <input id="f-totp" type="text" placeholder="JBSW Y3DP… or otpauth://…" value="${attr(e?.totp)}" />
    </div>
    <div><label>Notes</label><textarea id="f-notes">${escapeHtml(e?.notes ?? '')}</textarea></div>
    <p id="err" class="error"></p>
    <div class="row">
      <button id="save">${e ? 'Update' : 'Save'}</button>
      <button id="cancel" class="ghost">Cancel</button>
    </div>
  `
  const passEl = byId<HTMLInputElement>('f-pass')
  const revealBtn = byId<HTMLButtonElement>('f-reveal')
  // A saved password starts protected: revealing it requires re-verifying the master
  // password. A password the user generates/types this session has nothing to protect.
  let needsVerify = Boolean(e?.password)
  const setRevealed = (on: boolean): void => {
    passEl.type = on ? 'text' : 'password'
    revealBtn.innerHTML = on ? ICON.eyeOff : ICON.eye
    revealBtn.title = revealBtn.ariaLabel = on ? 'Hide password' : 'Reveal password'
  }
  revealBtn.addEventListener('click', async () => {
    if (passEl.type === 'text') return setRevealed(false) // hide freely
    if (needsVerify && !(await promptMasterVerify(byId<HTMLDivElement>('f-pass-block')))) return
    setRevealed(true)
  })
  byId<HTMLButtonElement>('f-gen').addEventListener('click', () => {
    passEl.value = generatePassword(genOptions)
    needsVerify = false // it's a brand-new secret the user just created
    setRevealed(true)
  })
  byId<HTMLButtonElement>('cancel').addEventListener('click', () => renderMain('vault'))
  view.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') renderMain('vault')
  })
  byId<HTMLButtonElement>('save').addEventListener('click', async () => {
    const err = byId<HTMLParagraphElement>('err')
    let totp: string | undefined
    const totpRaw = byId<HTMLInputElement>('f-totp').value.trim()
    if (totpRaw) {
      try {
        // Accept either a full otpauth:// URI (extract the secret) or a bare base32 secret.
        totp = totpRaw.toLowerCase().startsWith('otpauth://')
          ? parseTOTPUri(totpRaw).secret
          : normalizeTOTPSecret(totpRaw)
      } catch {
        return (err.textContent = "Couldn't read that 2FA URI.")
      }
      if (!isValidTOTPSecret(totp)) return (err.textContent = 'Invalid 2FA secret (need 16+ base32 chars, A–Z 2–7).')
    }
    const payload = {
      title: byId<HTMLInputElement>('f-title').value.trim(),
      url: byId<HTMLInputElement>('f-url').value.trim(),
      username: byId<HTMLInputElement>('f-user').value.trim(),
      password: byId<HTMLInputElement>('f-pass').value,
      notes: byId<HTMLTextAreaElement>('f-notes').value,
      totp,
    }
    if (!payload.title && !payload.url) {
      return (err.textContent = 'Add a title or URL.')
    }
    const res = e
      ? await sendMessage({ type: 'update', entry: { ...e, ...payload } })
      : await sendMessage({ type: 'add', entry: payload })
    if (!res.ok) return (err.textContent = res.error)
    renderMain('vault')
  })
}

// ---------- Settings ----------
/** Markup for a pill toggle switch wrapping a real checkbox (id drives the change handler). */
function toggleRow(id: string, label: string, checked: boolean): string {
  return `<label class="toggle">
    <input id="${id}" type="checkbox" ${checked ? 'checked' : ''} />
    <span class="toggle-track"></span>
    <span class="toggle-text">${escapeHtml(label)}</span>
  </label>`
}

function renderSettings(): void {
  const view = byId<HTMLDivElement>('view')
  const s = settingsCache
  view.innerHTML = `
    <div>
      <label for="set-lock">Auto-lock after (minutes)</label>
      <input id="set-lock" type="number" min="1" max="240" value="${s.autoLockMinutes}" />
    </div>
    ${toggleRow('set-capture', 'Offer to save passwords after login', s.captureEnabled)}
    <div>
      <label for="set-clip">Clear clipboard after (seconds, 0 = never)</label>
      <input id="set-clip" type="number" min="0" max="600" value="${s.clipboardClearSeconds}" />
    </div>
    <p id="set-status" class="hint"></p>

    <hr style="border:none;border-top:1px solid var(--border-soft);margin:0" />
    <p class="step">Recovery phrase</p>
    <p id="rec-state" class="hint">Checking…</p>
    <div id="rec-action"></div>

    <hr style="border:none;border-top:1px solid var(--border-soft);margin:0" />
    <div id="bio-action"></div>
    <p id="bio-state" class="hint">Checking…</p>

    <hr style="border:none;border-top:1px solid var(--border-soft);margin:0" />
    <p class="step">Backup &amp; restore</p>
    <p class="hint">An encrypted backup file you can store anywhere — protected by a separate export password.</p>
    <div class="row">
      <button id="export-btn" class="ghost small">Export…</button>
      <button id="import-btn" class="ghost small">Import…</button>
    </div>

    <hr style="border:none;border-top:1px solid var(--border-soft);margin:0" />
    <p class="step" style="color:var(--danger)">Danger zone</p>
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
    const recState = byId<HTMLParagraphElement>('rec-state')
    if (!recState?.isConnected) return // tab switched away during the await
    const has = res.ok && res.data.hasRecovery
    recState.textContent = has
      ? 'A recovery phrase is set. Regenerating replaces it — the old one stops working.'
      : 'No recovery phrase yet. Set one up so you can restore the vault if you forget your master password.'
    const action = byId<HTMLDivElement>('rec-action')
    const btn = document.createElement('button')
    btn.className = 'ghost small'
    btn.textContent = has ? 'Regenerate recovery phrase' : 'Set up recovery phrase'
    btn.addEventListener('click', () => promptForRecovery())
    action.appendChild(btn)
  })()

  void renderBiometricSetting()

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
  addRevealToggle(ep)
  byId<HTMLButtonElement>('cancel').addEventListener('click', backToSettings)
  const exportBtn = byId<HTMLButtonElement>('do-export')
  const submit = () =>
    withPending(exportBtn, 'Exporting…', async () => {
      if (ep.value.length < 8) return void (err.textContent = 'Use at least 8 characters.')
      if (ep.value !== ep2.value) return void (err.textContent = 'Passwords do not match.')
      const res = await sendMessage<{ json: string }>({ type: 'exportVault', exportPassword: ep.value })
      if (!res.ok) return void (err.textContent = res.error)
      downloadBlob(res.data.json, `pass123-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')
      backToSettings()
    })
  exportBtn.addEventListener('click', submit)
  ep2.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
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
  addRevealToggle(ip)
  byId<HTMLButtonElement>('cancel').addEventListener('click', backToSettings)
  const importBtn = byId<HTMLButtonElement>('do-import')
  const submit = () =>
    withPending(importBtn, 'Importing…', async () => {
      const f = file.files?.[0]
      if (!f) return void (err.textContent = 'Choose a backup file.')
      if (!ip.value) return void (err.textContent = 'Enter the export password.')
      const json = await f.text()
      const res = await sendMessage<{ added: number }>({ type: 'importVault', json, exportPassword: ip.value })
      if (!res.ok) return void (err.textContent = res.error)
      err.className = 'hint'
      err.textContent = `Imported ${res.data.added} ${res.data.added === 1 ? 'entry' : 'entries'}.`
      setTimeout(backToSettings, 1200)
    })
  importBtn.addEventListener('click', submit)
  ip.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
  file.focus()
}

function backToSettings(): void {
  lockBtn.hidden = false
  renderMain('settings')
}

// ---------- Biometric unlock ----------
/** OS-aware label for the platform authenticator. */
function biometricName(): string {
  const ua = navigator.userAgent
  if (/Windows/.test(ua)) return 'Windows Hello'
  if (/Mac|iPhone|iPad/.test(ua)) return 'Touch ID'
  if (/Android/.test(ua)) return 'fingerprint'
  return 'biometrics'
}

/** Render the Settings biometric row: enable, disable, or "unavailable". */
async function renderBiometricSetting(): Promise<void> {
  const state = byId<HTMLParagraphElement>('bio-state')
  const action = byId<HTMLDivElement>('bio-action')
  action.innerHTML = ''
  if (!(await isPlatformAuthenticatorAvailable())) {
    state.textContent = `No ${biometricName()} authenticator is available on this device.`
    return
  }
  const info = await sendMessage<{ credentialId: string | null }>({ type: 'biometricInfo' })
  const enabled = info.ok && !!info.data.credentialId
  state.textContent = enabled
    ? `${biometricName()} unlock is on. Your vault key is wrapped by this device's authenticator.`
    : `Unlock with ${biometricName()} instead of typing your master password.`
  action.innerHTML = toggleRow('set-bio', `${biometricName()} unlock`, enabled)
  byId<HTMLInputElement>('set-bio').addEventListener('change', async () => {
    if (enabled) {
      await sendMessage({ type: 'removeBiometric' })
      void renderBiometricSetting()
    } else {
      // Enrolling needs the master password + an authenticator prompt, so hand off to
      // a dedicated screen; cancelling returns to Settings (which re-syncs the toggle).
      renderEnableBiometric()
    }
  })
}

/** Confirm the master password, then enroll a platform credential and wrap the vault key. */
function renderEnableBiometric(): void {
  app.innerHTML = `
    <p class="hint">Confirm your master password, then ${escapeHtml(biometricName())} will prompt you. Your master password keeps working as a fallback.</p>
    <div><label for="bmp">Master password</label><input id="bmp" type="password" autocomplete="current-password" /></div>
    <p id="err" class="error"></p>
    <div class="row">
      <button id="go">Continue</button>
      <button id="cancel" class="ghost">Cancel</button>
    </div>
  `
  const bmp = byId<HTMLInputElement>('bmp')
  const err = byId<HTMLParagraphElement>('err')
  addRevealToggle(bmp)
  byId<HTMLButtonElement>('cancel').addEventListener('click', () => renderMain('settings'))
  const go = async () => {
    const check = await sendMessage({ type: 'unlock', masterPassword: bmp.value })
    if (!check.ok) return (err.textContent = 'Wrong master password.')
    err.textContent = `Waiting for ${biometricName()}…`
    try {
      const { credentialId, prfOutput } = await enrollBiometric()
      const res = await sendMessage({
        type: 'addBiometric',
        currentSecret: bmp.value,
        prfOutput,
        credentialId,
      })
      if (!res.ok) return (err.textContent = res.error)
      renderMain('settings')
    } catch (e) {
      err.textContent = (e as Error).message
    }
  }
  byId<HTMLButtonElement>('go').addEventListener('click', go)
  bmp.addEventListener('keydown', (e) => e.key === 'Enter' && go())
  bmp.focus()
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
  addRevealToggle(cmp)
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
  if (!tab?.id) return void toast('No active page to fill.', { danger: true, icon: '!' })
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'fillCredentials',
      username: e.username,
      password: e.password,
    })
    window.close()
  } catch {
    // Content script absent (chrome:// page, or no login form here) — say so
    // instead of doing nothing, which reads as a broken button.
    toast("Can't autofill on this page.", { danger: true, icon: '!' })
  }
}

/**
 * Inline master-password challenge: appends a small verify row under `host` and
 * resolves true once the worker confirms the password. Used to gate revealing a
 * saved password. The plaintext already lives in the popup (trusted surface), so
 * this guards against shoulder-surfing / an unattended unlocked popup, not a
 * determined attacker.
 */
function promptMasterVerify(host: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    host.querySelector('.verify-box')?.remove()
    const box = document.createElement('div')
    box.className = 'verify-box'
    box.innerHTML = `
      <p class="hint" style="margin:8px 0 4px">Enter your master password to reveal this password.</p>
      <input type="password" class="verify-mp" placeholder="Master password" autocomplete="current-password" />
      <p class="error verify-err" style="margin:4px 0 0"></p>
      <div class="row" style="margin-top:6px">
        <button class="verify-ok">Reveal</button>
        <button class="ghost verify-cancel">Cancel</button>
      </div>`
    const input = box.querySelector<HTMLInputElement>('.verify-mp')!
    const err = box.querySelector<HTMLParagraphElement>('.verify-err')!
    const okBtn = box.querySelector<HTMLButtonElement>('.verify-ok')!
    const done = (result: boolean): void => {
      box.remove()
      resolve(result)
    }
    let busy = false
    const attempt = async (): Promise<void> => {
      if (busy) return
      err.textContent = ''
      if (!input.value) {
        err.textContent = 'Enter your master password.'
        return input.focus()
      }
      busy = true
      okBtn.disabled = true
      const label = okBtn.textContent
      okBtn.textContent = 'Checking…'
      try {
        const res = await sendMessage<{ valid: boolean }>({ type: 'verifyMaster', masterPassword: input.value })
        if (!res.ok) {
          // A real failure (e.g. the vault auto-locked) — surface it, don't call it a wrong password.
          err.textContent = res.error || 'Could not verify right now.'
          return
        }
        if (res.data.valid) return done(true)
        err.textContent = 'Wrong master password.'
        input.value = ''
        input.focus()
      } finally {
        busy = false
        okBtn.disabled = false
        okBtn.textContent = label
      }
    }
    okBtn.addEventListener('click', () => void attempt())
    box.querySelector<HTMLButtonElement>('.verify-cancel')!.addEventListener('click', () => done(false))
    input.addEventListener('input', () => (err.textContent = ''))
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void attempt()
      if (ev.key === 'Escape') done(false)
    })
    host.appendChild(box) // full-width block under the password row, not inside it
    input.focus()
  })
}

async function copySecret(value: string, label = 'Copied'): Promise<void> {
  if (!value) return
  await navigator.clipboard.writeText(value)
  // Best-effort clipboard auto-clear after the configured delay (0 = never).
  const secs = settingsCache.clipboardClearSeconds
  if (secs > 0) {
    setTimeout(() => {
      navigator.clipboard
        .writeText('')
        .then(() => {
          // Confirm the security action — but only if the popup is still open to see it.
          if (document.visibilityState === 'visible') toast('Clipboard cleared')
        })
        .catch(() => {})
    }, secs * 1000)
    toast(`${label} · clears in ${secs}s`)
  } else {
    toast(label)
  }
}

interface ToastOpts {
  icon?: string
  danger?: boolean
  action?: { label: string; onClick: () => void }
  durationMs?: number
}

let toastHost: HTMLElement | null = null

/** Transient status message at the popup bottom. With an action it lingers longer. */
function toast(msg: string, opts: ToastOpts = {}): void {
  if (!toastHost) {
    toastHost = document.createElement('div')
    toastHost.className = 'toast-host'
    document.body.appendChild(toastHost)
  }
  const el = document.createElement('div')
  el.className = `toast${opts.danger ? ' danger' : ''}`
  el.innerHTML = `<span class="toast-ico">${opts.icon ?? '✓'}</span><span class="toast-msg"></span>`
  el.querySelector('.toast-msg')!.textContent = msg
  const dismiss = (): void => el.remove()
  if (opts.action) {
    const b = document.createElement('button')
    b.className = 'toast-action'
    b.textContent = opts.action.label
    b.addEventListener('click', () => {
      opts.action!.onClick()
      dismiss()
    })
    el.appendChild(b)
  }
  toastHost.appendChild(el)
  setTimeout(dismiss, opts.durationMs ?? (opts.action ? 5000 : 2200))
}

/** Rough entropy estimate for a typed password, mirroring the generator's pool model. */
function estimateEntropy(pw: string): number {
  if (!pw) return 0
  let pool = 0
  if (/[a-z]/.test(pw)) pool += 26
  if (/[A-Z]/.test(pw)) pool += 26
  if (/[0-9]/.test(pw)) pool += 10
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32
  return Math.round(pw.length * Math.log2(pool || 1))
}

/** Wire a master-password input to a live strength meter + label (setup / new master). */
function wireStrengthMeter(input: HTMLInputElement, meter: HTMLElement, label: HTMLElement): void {
  const update = (): void => {
    const bits = estimateEntropy(input.value)
    const s = strengthFromEntropy(bits)
    meter.className = `s-${s}`
    meter.style.width = `${Math.min(100, (bits / 128) * 100)}%`
    label.textContent = input.value ? `~${bits} bits · ${s}` : ''
  }
  input.addEventListener('input', update)
  update()
}

/** Paint the green fill of a custom range slider from its current value. */
function setSliderFill(el: HTMLInputElement): void {
  const min = Number(el.min || 0)
  const max = Number(el.max || 100)
  const pct = max === min ? 0 : ((Number(el.value) - min) / (max - min)) * 100
  el.style.setProperty('--pct', `${pct}%`)
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

/** Inline-SVG icon set (replaces emoji glyphs that render inconsistently across OSes). */
const ICON = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.9 4.6A11 11 0 0 1 12 4.5c6.4 0 10 7 10 7a18 18 0 0 1-3.2 4.1M6.1 6.1A18 18 0 0 0 2 11.5s3.6 7 10 7a11 11 0 0 0 3.1-.4"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
}

/** Wrap a password input with an inline reveal/hide eye toggle. */
function addRevealToggle(input: HTMLInputElement): void {
  const wrap = document.createElement('div')
  wrap.className = 'pw-wrap'
  input.parentNode!.insertBefore(wrap, input)
  wrap.appendChild(input)
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'pw-eye'
  btn.innerHTML = ICON.eye
  btn.setAttribute('aria-label', 'Reveal password')
  btn.addEventListener('click', () => {
    const reveal = input.type === 'password'
    input.type = reveal ? 'text' : 'password'
    btn.innerHTML = reveal ? ICON.eyeOff : ICON.eye
    btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Reveal password')
    input.focus()
  })
  wrap.appendChild(btn)
}

/** Disable a button and show a pending label while `fn` runs; restore on completion. */
async function withPending<T>(
  btn: HTMLButtonElement,
  pendingLabel: string,
  fn: () => Promise<T>,
): Promise<T> {
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = pendingLabel
  try {
    return await fn()
  } finally {
    btn.disabled = false
    btn.textContent = original
  }
}

void route()
