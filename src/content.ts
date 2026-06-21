/**
 * Content script: login autofill + capture-on-submit.
 *
 *  - Autofill: fills the nearest username/password fields when the popup asks.
 *  - Capture:  on a login submit, sends the credentials to the background worker,
 *    which (if the vault is unlocked) decides whether to offer save/update. The
 *    decision surfaces as an in-page banner. The captured password is held only
 *    in this isolated content-script world and the background's memory — never in
 *    the page DOM and never sent back down to the page.
 *
 * Credentials only leave this script after the user explicitly clicks Save/Update.
 */

import { sendMessage, type PendingInfo } from './lib/messages'
import {
  classifyForm,
  findConfirmField,
  findNewPasswordField,
  findPasswordField,
  findUsernameField,
  isEmailLikeField,
  passwordFields,
} from './lib/formdetect'

// With `all_frames`, this script runs in every frame. Fill + capture work per-frame
// (so iframe'd login forms are handled), but the save/update banner renders only in
// the top frame — never inside an embedded ad/widget iframe.
const isTopFrame = window === window.top

// ---------- autofill helpers ----------
function setValue(input: HTMLInputElement, value: string): void {
  input.focus()
  input.value = value
  // Fire events so frameworks (React/Vue) register the change.
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

// ---------- autofill (popup -> content) ----------
interface FillMessage {
  type: 'fillCredentials'
  username: string
  password: string
}

chrome.runtime.onMessage.addListener((msg: FillMessage, _sender, sendResponse) => {
  if (msg.type !== 'fillCredentials') return
  const pw = findPasswordField(document)
  const user = findUsernameField(document, pw)
  // The popup broadcasts to every frame; frames without login fields stay silent so
  // the field-bearing frame is the one that answers (and we don't hold the channel
  // open from empty frames).
  if (!pw && !user) return
  if (user) setValue(user, msg.username)
  if (pw) setValue(pw, msg.password)
  sendResponse({ ok: true })
  return true
})

// ---------- capture-on-submit ----------
let lastSignature = ''
// Username typed on an earlier step of a multi-step / SPA login, where the password
// appears on a later step. Lives only in this isolated content world — it is never
// written back to the page DOM, and it dies with the document on a full navigation.
let rememberedUsername = ''

function rememberUsername(): void {
  const u = findUsernameField(document, null)
  if (u && u.value.trim()) rememberedUsername = u.value.trim()
}

/**
 * Cross-document multi-step: on a genuine username-first step (a username typed,
 * no password field on the page at all), hand the username to the worker so the
 * password-only page that follows a full navigation can be captured with it.
 */
async function rememberUsernameAcrossPages(): Promise<void> {
  if (passwordFields(document).length > 0) return // not a username-only step
  const u = findUsernameField(document, null)
  const username = (u?.value.trim() || rememberedUsername).trim()
  if (!username) return
  await sendMessage({ type: 'rememberUsername', hostname: location.hostname, username })
}

function collectCredentials(): { username: string; password: string } | null {
  const pw = findPasswordField(document, true)
  if (!pw || !pw.value) return null
  const user = findUsernameField(document, pw)
  // Fall back to the remembered username when this step has no visible username field.
  const username = user?.value.trim() || rememberedUsername
  return { username, password: pw.value }
}

async function captureNow(): Promise<void> {
  const creds = collectCredentials()
  if (!creds || !creds.password) return
  const sig = `${location.hostname}|${creds.username}|${creds.password}`
  if (sig === lastSignature) return // already offered for this exact login
  lastSignature = sig

  const res = await sendMessage<{ stored: boolean }>({
    type: 'capturePending',
    hostname: location.hostname,
    username: creds.username,
    password: creds.password,
  })
  if (res.ok && res.data.stored) void maybeShowBanner()
}

// Keep the username in view as it's typed, so a later password-only step can pair it.
document.addEventListener(
  'input',
  (e) => {
    const t = e.target as HTMLInputElement | null
    if (t?.tagName === 'INPUT' && t.type !== 'password') rememberUsername()
  },
  true,
)

// On a username-only step, push the username to the worker before navigating away.
document.addEventListener(
  'change',
  (e) => {
    const t = e.target as HTMLInputElement | null
    if (t?.tagName === 'INPUT' && t.type !== 'password') void rememberUsernameAcrossPages()
  },
  true,
)

// Real form submits: capture a password step, or remember a username-only step.
document.addEventListener(
  'submit',
  () => {
    void captureNow()
    void rememberUsernameAcrossPages()
  },
  true,
)

// JS logins that don't fire a form submit: capture after a click on a submit-like
// control while a password field holds a value. Deferred so the value settles. On a
// username-only step (the "Next" button), remember the username for the next page.
document.addEventListener(
  'click',
  (e) => {
    const el = (e.target as HTMLElement)?.closest('button, input[type="submit"], [role="button"]')
    if (!el) return
    if (findPasswordField(document, true)) setTimeout(() => void captureNow(), 0)
    else void rememberUsernameAcrossPages()
  },
  true,
)

// SPA logins that navigate via the History API instead of submitting a form.
// Snapshot the credentials synchronously *before* the route swaps the form out.
function hookSpaNavigation(): void {
  const fire = (): void => {
    if (findPasswordField(document, true)) void captureNow()
    else void rememberUsernameAcrossPages()
  }
  const wrap = (name: 'pushState' | 'replaceState'): void => {
    const orig = history[name].bind(history)
    history[name] = ((...args: unknown[]) => {
      fire()
      return (orig as (...a: unknown[]) => unknown)(...args)
    }) as History[typeof name]
  }
  wrap('pushState')
  wrap('replaceState')
  window.addEventListener('popstate', fire, true)
}
hookSpaNavigation()

// ---------- registration assist (sign-up forms) ----------
// On a sign-up form we offer to generate a strong password, fill it (+ confirm),
// and — crucially — save it *proactively* before submit, so a generated new-account
// password can't be lost if the post-submit capture misfires (the category's #1
// complaint). Detection runs on load and on DOM mutations, since sign-up forms are
// often rendered late or swapped in by a framework.
let signupOffered = '' // signature of the form we've already offered for, to avoid nagging

function maybeOfferSignup(): void {
  if (!isTopFrame) return // offer only in the top document, like the capture banner
  if (passwordFields(document).length === 0) return // cheap early-out (also skips ad iframes' work)
  if (classifyForm(document) !== 'signup') return
  const newPw = findNewPasswordField(document)
  if (!newPw || newPw.value) return // nothing to offer if the user already has a password in it
  const sig = `${location.host}|${newPw.id || newPw.name || 'pw'}`
  if (sig === signupOffered) return
  signupOffered = sig
  void showSignupBanner()
}

/** The empty email field on the current sign-up form we could drop a saved email into. */
function emptyEmailField(): HTMLInputElement | null {
  const user = findUsernameField(document, findNewPasswordField(document))
  return user && isEmailLikeField(user) && !user.value.trim() ? user : null
}

async function fillGeneratedPassword(email: string, password: string): Promise<void> {
  const newPw = findNewPasswordField(document)
  if (!newPw || !password) return
  setValue(newPw, password)
  const confirm = findConfirmField(document, newPw)
  if (confirm) setValue(confirm, password)
  // Fill a saved email only into a still-empty email field (never overwrite the user).
  const emailField = emptyEmailField()
  if (email && emailField) setValue(emailField, email)
  // Proactive provisional save — pair any username/email now on the page (or remembered
  // from an earlier step). The password is now safely in the vault before submit.
  const user = findUsernameField(document, newPw)
  const username = (user?.value.trim() || rememberedUsername).trim()
  await sendMessage({ type: 'provisionalSave', hostname: location.hostname, username, password })
}

// Re-scan on DOM changes (late-rendered / SPA sign-up forms), debounced so a busy
// page can't thrash. Our own banner insertion is ignored by the per-form signature.
let scanTimer = 0
function scheduleSignupScan(): void {
  clearTimeout(scanTimer)
  scanTimer = setTimeout(maybeOfferSignup, 400) as unknown as number
}

// ---------- banner ----------
const BANNER_ID = 'pass123-capture-banner'
const SIGNUP_BANNER_ID = 'pass123-signup-banner'

// Cyber-industrial green theme, shared by both in-page banners (Pass123 design system).
// Self-contained: no external fonts are loaded into the host page — that would leak a
// request to Google on every site and can trip the page's CSP — so we fall back to the
// platform's mono/sans, which carry the same monospace-on-dark look.
const THEME_CSS = `
  :host { all: initial; }
  @keyframes p123-scan { from { transform: scaleX(0) } to { transform: scaleX(1) } }
  @keyframes p123-glow { 0%,100% { box-shadow: 0 0 8px rgba(57,255,110,.4) } 50% { box-shadow: 0 0 16px rgba(57,255,110,.7) } }
  .bar {
    position: fixed; z-index: 2147483647; top: 16px; right: 16px;
    width: 340px; box-sizing: border-box; overflow: hidden;
    font-family: "IBM Plex Mono", ui-monospace, "Cascadia Code", "Segoe UI Mono", "Roboto Mono", monospace;
    font-size: 12px; line-height: 1.5; color: #f0f0f0;
    background: #17171f; border: 1px solid rgba(255,255,255,.09); border-radius: 18px;
    padding: 15px 16px 16px;
    box-shadow: 0 2px 4px hsl(237 30% 3%/.7), 0 14px 36px hsl(237 30% 3%/.55), inset 0 1px 0 rgba(255,255,255,.06);
  }
  .bar.success {
    border-color: rgba(57,255,110,.32);
    box-shadow: 0 2px 4px hsl(237 30% 3%/.7), 0 14px 36px hsl(237 30% 3%/.55), 0 0 34px rgba(57,255,110,.12), inset 0 1px 0 rgba(255,255,255,.06);
  }
  .scan { position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, transparent, #39ff6e, transparent); animation: p123-scan .5s ease both; }
  .row { display: flex; align-items: center; gap: 9px; }
  .logo { width: 22px; height: 22px; flex: none; border-radius: 7px;
    background: linear-gradient(180deg, #39ff6e, #2bd457); display: flex; align-items: center; justify-content: center;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.4), 0 0 12px rgba(57,255,110,.35); }
  .logo span { font-size: 11px; filter: grayscale(1) brightness(0); }
  .brand { font-family: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    font-weight: 800; font-size: 15px; letter-spacing: -.01em; }
  .brand b { color: #39ff6e; font-weight: 800; }
  .badge { font-size: 8px; letter-spacing: .16em; text-transform: uppercase; color: #39ff6e;
    border: 1px solid rgba(57,255,110,.35); border-radius: 100px; padding: 3px 7px; }
  .close { all: unset; margin-left: auto; width: 24px; height: 24px; border-radius: 7px; cursor: pointer;
    display: flex; align-items: center; justify-content: center; color: rgba(240,240,240,.4); font-size: 15px; line-height: 1;
    transition: color .12s ease, background .12s ease; }
  .close:hover { color: #f0f0f0; background: rgba(255,255,255,.06); }
  p { margin: 11px 0 13px; font-size: 12px; line-height: 1.55; color: rgba(240,240,240,.62); }
  p b { color: #f0f0f0; font-weight: 400; word-break: break-all; }
  p .host { color: #39ff6e; }
  .lbl { font-size: 8px; letter-spacing: .14em; text-transform: uppercase; color: rgba(240,240,240,.4); }
  .well { background: #1e1e28; border: 1px solid rgba(255,255,255,.09); border-radius: 11px;
    box-shadow: inset 0 1px 3px hsl(237 30% 3%/.55); padding: 9px 12px; display: flex; align-items: center; gap: 10px; }
  .well .lbl { width: 34px; flex: none; }
  .well .v { flex: 1; min-width: 0; font-size: 11.5px; color: #f0f0f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .well .pw { color: #39ff6e; font-weight: 500; letter-spacing: .02em; font-size: 13px; }
  .regen { all: unset; width: 28px; height: 28px; flex: none; border-radius: 8px; background: #17171f;
    border: 1px solid rgba(255,255,255,.12); color: rgba(240,240,240,.7); cursor: pointer;
    display: flex; align-items: center; justify-content: center; font-size: 13px;
    transition: transform .25s ease, color .12s ease, border-color .12s ease; }
  .regen:hover { color: #39ff6e; border-color: rgba(57,255,110,.4); }
  .regen:active { transform: rotate(-180deg); }
  .strength { display: flex; align-items: center; gap: 9px; }
  .meter { flex: 1; height: 5px; background: #1e1e28; border-radius: 100px; overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,.5); }
  .meter > i { display: block; width: 88%; height: 100%; background: #39ff6e; border-radius: 100px; animation: p123-glow 2.4s ease-in-out infinite; }
  .strength .lbl { color: #39ff6e; letter-spacing: .06em; font-size: 9px; }
  select { width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 11px;
    border: 1px solid rgba(255,255,255,.09); background: #1e1e28; color: #f0f0f0;
    font-family: inherit; font-size: 11.5px; box-shadow: inset 0 1px 3px hsl(237 30% 3%/.55); }
  .actions { display: flex; gap: 9px; }
  .use { flex: 1; cursor: pointer; border: none; border-radius: 100px; padding: 11px; font-family: inherit;
    font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; font-weight: 600; background: #39ff6e; color: #000;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 3px 0 rgba(0,0,0,.55), 0 5px 12px rgba(0,0,0,.22), 0 0 18px rgba(57,255,110,.3);
    transition: transform .08s cubic-bezier(.4,0,.2,1); }
  .use:hover { transform: translateY(-1px); }
  .use:active { transform: translateY(1px); }
  .dismiss { flex: none; cursor: pointer; border: 1px solid rgba(255,255,255,.16); background: transparent;
    color: rgba(240,240,240,.78); border-radius: 100px; padding: 11px 16px; font-family: inherit;
    font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; transition: color .12s ease, border-color .12s ease; }
  .dismiss:hover { color: #f0f0f0; border-color: rgba(255,255,255,.28); }
  .ok { display: flex; align-items: center; gap: 11px; }
  .ok .check { width: 34px; height: 34px; flex: none; border-radius: 11px; background: linear-gradient(180deg, #39ff6e, #2bd457);
    display: flex; align-items: center; justify-content: center; color: #000; font-size: 17px; font-weight: 800;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.4), 0 0 16px rgba(57,255,110,.4); }
  .ok .t { font-family: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif; font-weight: 800; font-size: 14px; letter-spacing: -.01em; }
  .ok .t.err { color: #ff6b6b; }
  .ok .s { font-size: 10px; letter-spacing: .04em; color: rgba(240,240,240,.45); margin-top: 3px; }
`

/** The Pass123 brand row shared by every banner: lock chip + wordmark + optional badge + close. */
function brandRow(badge?: string): string {
  return `
    <div class="row">
      <div class="logo"><span>🔒</span></div>
      <span class="brand">Pass<b>123</b></span>
      ${badge ? `<span class="badge">${escapeHtml(badge)}</span>` : ''}
      <button class="close" title="Dismiss">×</button>
    </div>`
}

/** Offer to generate + fill a strong password on a detected sign-up form. */
async function showSignupBanner(): Promise<void> {
  if (!isTopFrame) return

  // Suggest an email only when the form has an empty email field. Emails are derived
  // from existing vault entries (no new PII); a single one is pre-filled, several get
  // a picker so we never sign the user up under the wrong identity. Empty while locked.
  let emails: string[] = []
  if (emptyEmailField()) {
    const res = await sendMessage<{ emails: string[] }>({ type: 'suggestEmails' })
    if (res.ok) emails = res.data.emails
  }

  // Generate the password up front so the banner can preview it (and regenerate live)
  // before the user commits. Pure RNG in the worker — works regardless of lock state.
  let currentPw = ''
  const pwRes = await sendMessage<{ password: string }>({ type: 'generateForFill' })
  if (pwRes.ok) currentPw = pwRes.data.password

  document.getElementById(SIGNUP_BANNER_ID)?.remove()
  const host = document.createElement('div')
  host.id = SIGNUP_BANNER_ID
  const root = host.attachShadow({ mode: 'closed' })

  // Sunken email well: a single saved address shows inline; several get a picker so we
  // never register under the wrong identity; none → omit it (the leanest prompt).
  const emailUi =
    emails.length === 0
      ? ''
      : emails.length === 1
        ? `<div class="well" style="margin-bottom:9px"><span class="lbl">Email</span><span class="v">${escapeHtml(emails[0])}</span></div>`
        : `<div style="margin-bottom:9px">
             <div class="lbl" style="margin-bottom:7px">Email</div>
             <select class="email-pick">${emails
               .map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`)
               .join('')}</select>
           </div>`

  root.innerHTML = `
    <style>${THEME_CSS}</style>
    <div class="bar">
      <div class="scan"></div>
      ${brandRow('New account')}
      <p>Use a strong generated password — encrypted to your vault the instant you submit.</p>
      ${emailUi}
      <div class="well" style="margin-bottom:14px">
        <span class="v pw">${escapeHtml(currentPw)}</span>
        <button class="regen" title="Regenerate">⟳</button>
      </div>
      <div class="strength" style="margin-bottom:14px">
        <div class="meter"><i></i></div>
        <span class="lbl">Strong</span>
      </div>
      <div class="actions">
        <button class="use">Use strong password</button>
        <button class="dismiss">Not now</button>
      </div>
    </div>
  `

  const remove = () => host.remove()
  const pwEl = root.querySelector<HTMLElement>('.pw')!
  root.querySelector('.close')!.addEventListener('click', remove)
  root.querySelector('.dismiss')!.addEventListener('click', remove)
  root.querySelector('.regen')!.addEventListener('click', async () => {
    const res = await sendMessage<{ password: string }>({ type: 'generateForFill' })
    if (res.ok && res.data.password) {
      currentPw = res.data.password
      pwEl.textContent = currentPw
    }
  })
  root.querySelector('.use')!.addEventListener('click', async () => {
    const picker = root.querySelector<HTMLSelectElement>('.email-pick')
    const email = picker ? picker.value : (emails[0] ?? '')
    await fillGeneratedPassword(email, currentPw)
    const bar = root.querySelector('.bar')!
    bar.classList.add('success')
    bar.innerHTML = `
      <div class="scan"></div>
      <div class="ok">
        <div class="check">✓</div>
        <div><div class="t">Filled &amp; saved to vault</div><div class="s">Strong · encrypted</div></div>
      </div>`
    setTimeout(remove, 2600)
  })

  ;(document.body ?? document.documentElement).appendChild(host)
}

async function maybeShowBanner(): Promise<void> {
  // Only the top frame renders the banner. A capture made inside an iframe is still
  // stored in the background (keyed by registrable domain / same-tab window); the
  // top frame surfaces it on its next load or navigation — which is exactly what an
  // iframe SSO login that then redirects the parent does. This also stops every ad
  // iframe from firing a `pendingFor` round-trip on load.
  if (!isTopFrame) return
  const res = await sendMessage<PendingInfo>({ type: 'pendingFor', hostname: location.hostname })
  if (!res.ok || res.data.action === 'none') return
  renderBanner(res.data)
}

function renderBanner(info: PendingInfo): void {
  document.getElementById(BANNER_ID)?.remove()

  const host = document.createElement('div')
  host.id = BANNER_ID
  const root = host.attachShadow({ mode: 'closed' })

  const isUpdate = info.action === 'update'
  const who = info.username ? ` for <b>${escapeHtml(info.username)}</b>` : ''
  root.innerHTML = `
    <style>${THEME_CSS}</style>
    <div class="bar">
      <div class="scan"></div>
      ${brandRow()}
      <p>${isUpdate ? 'Update the saved password' : 'Save this login'}${who} on <span class="host">${escapeHtml(info.hostname)}</span>?</p>
      <div class="actions">
        <button class="use">${isUpdate ? 'Update' : 'Save'}</button>
        <button class="dismiss">Not now</button>
      </div>
    </div>
  `

  const remove = () => host.remove()
  const dismiss = () => {
    void sendMessage({ type: 'captureDismiss', hostname: info.hostname })
    remove()
  }
  root.querySelector('.close')!.addEventListener('click', dismiss)
  root.querySelector('.dismiss')!.addEventListener('click', dismiss)
  root.querySelector('.use')!.addEventListener('click', async () => {
    const res = await sendMessage<{ saved: boolean }>({ type: 'captureConfirm', hostname: info.hostname })
    const bar = root.querySelector('.bar')!
    bar.classList.add('success')
    bar.innerHTML = res.ok
      ? `<div class="scan"></div><div class="ok"><div class="check">✓</div><div class="t">${isUpdate ? 'Updated' : 'Saved'} to vault</div></div>`
      : `<div class="scan"></div><div class="ok"><div class="t err">${escapeHtml(res.ok ? '' : res.error)}</div></div>`
    setTimeout(remove, 2600)
  })

  ;(document.body ?? document.documentElement).appendChild(host)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

// On page load (e.g. after a login navigated here), surface any pending capture.
void maybeShowBanner()

// Watch for sign-up forms appearing (initial + late-rendered / SPA), top frame only.
if (isTopFrame) {
  maybeOfferSignup()
  new MutationObserver(scheduleSignupScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
}
