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
import { findPasswordField, findUsernameField, passwordFields } from './lib/formdetect'

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

// ---------- banner ----------
const BANNER_ID = 'pass123-capture-banner'

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
  const who = info.username ? ` for ${info.username}` : ''
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        position: fixed; z-index: 2147483647; top: 16px; right: 16px;
        width: 320px; box-sizing: border-box;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 13px;
        color: #e6e8ec; background: #1a1d24; border: 1px solid #2c313c;
        border-radius: 12px; padding: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.45);
      }
      .row { display:flex; align-items:center; gap:8px; }
      .brand { font-weight:700; letter-spacing:.4px; }
      .brand b { color:#6c8cff; }
      p { margin: 8px 0 12px; color:#c8ccd6; line-height:1.35; }
      p span { color:#fff; word-break:break-all; }
      .actions { display:flex; gap:8px; }
      button { flex:1; cursor:pointer; border:none; border-radius:8px; padding:8px 10px;
        font-size:13px; font-weight:600; font-family:inherit; }
      .save { background:#6c8cff; color:#fff; }
      .save:hover { background:#5a78e6; }
      .dismiss { background:transparent; color:#8b90a0; border:1px solid #2c313c; }
      .dismiss:hover { color:#e6e8ec; background:#232730; }
      .done { color:#5fd38a; font-weight:600; }
      .close { all:unset; cursor:pointer; color:#8b90a0; margin-left:auto; font-size:16px; line-height:1; }
    </style>
    <div class="bar">
      <div class="row">
        <span class="brand">Pass<b>123</b></span>
        <button class="close" title="Dismiss">×</button>
      </div>
      <p>${isUpdate ? 'Update saved password' : 'Save this login'}<span>${who}</span> on <span>${escapeHtml(info.hostname)}</span>?</p>
      <div class="actions">
        <button class="save">${isUpdate ? 'Update' : 'Save'}</button>
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
  root.querySelector('.save')!.addEventListener('click', async () => {
    const res = await sendMessage<{ saved: boolean }>({ type: 'captureConfirm', hostname: info.hostname })
    const bar = root.querySelector('.bar')!
    bar.innerHTML = res.ok
      ? `<div class="row"><span class="brand">Pass<b>123</b></span><span class="done" style="margin-left:8px">${isUpdate ? 'Updated' : 'Saved'} ✓</span></div>`
      : `<div class="row"><span class="brand">Pass<b>123</b></span><span style="margin-left:8px;color:#ff6b6b">${escapeHtml(res.ok ? '' : res.error)}</span></div>`
    setTimeout(remove, 2200)
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
