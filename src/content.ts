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

// ---------- field detection ----------
function findPasswordField(requireValue = false): HTMLInputElement | null {
  const fields = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')]
  if (requireValue) return fields.find((f) => f.value) ?? null
  return fields[0] ?? null
}

function findUsernameField(pw: HTMLInputElement | null): HTMLInputElement | null {
  const explicit = document.querySelector<HTMLInputElement>(
    'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i]',
  )
  if (explicit) return explicit
  if (!pw) return null
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input')]
  const pwIndex = inputs.indexOf(pw)
  for (let i = pwIndex - 1; i >= 0; i--) {
    const t = inputs[i].type
    if (t === 'text' || t === 'email') return inputs[i]
  }
  return null
}

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
  const pw = findPasswordField()
  const user = findUsernameField(pw)
  if (user) setValue(user, msg.username)
  if (pw) setValue(pw, msg.password)
  sendResponse({ ok: Boolean(pw || user) })
  return true
})

// ---------- capture-on-submit ----------
let lastSignature = ''

function collectCredentials(): { username: string; password: string } | null {
  const pw = findPasswordField(true)
  if (!pw || !pw.value) return null
  const user = findUsernameField(pw)
  return { username: user?.value ?? '', password: pw.value }
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

// Real form submits.
document.addEventListener('submit', () => void captureNow(), true)

// JS logins that don't fire a form submit: capture after a click on a submit-like
// control while a password field holds a value. Deferred so the value settles.
document.addEventListener(
  'click',
  (e) => {
    const el = (e.target as HTMLElement)?.closest('button, input[type="submit"], [role="button"]')
    if (!el) return
    if (findPasswordField(true)) setTimeout(() => void captureNow(), 0)
  },
  true,
)

// ---------- banner ----------
const BANNER_ID = 'pass123-capture-banner'

async function maybeShowBanner(): Promise<void> {
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
