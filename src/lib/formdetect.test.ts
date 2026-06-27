// @vitest-environment happy-dom
/**
 * Spike 0 — the field-detection regression harness (docs/AUTOFILL_SPIKES.md).
 *
 * Before this, detection lived in content.ts welded to a real `document` and could
 * not be unit-tested. Now `formdetect.ts` takes an explicit root, so we drive it
 * against saved login-form fixtures under a headless DOM and lock in a baseline.
 *
 * Each `it` is one cell of the site × case matrix. The `it.todo`s at the bottom are
 * the *known-red* cases that Spikes 1 (iframe) and 2 (shadow DOM) will turn green —
 * they document the baseline honestly instead of pretending it's covered.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyForm,
  findConfirmField,
  findNewPasswordField,
  findPasswordField,
  findUsernameField,
  isEmailLikeField,
  isVisible,
  labelText,
} from './formdetect'

const FORMS = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/forms')

/** Load a fixture body fragment into the document and return the root to query. */
function loadForm(name: string): Document {
  document.body.innerHTML = readFileSync(join(FORMS, `${name}.html`), 'utf8')
  return document
}

/** Convenience: the detected username/password field ids for the current document. */
function detect(root: Document): { user: string | null; pass: string | null } {
  const pass = findPasswordField(root)
  const user = findUsernameField(root, pass)
  return { user: user?.id ?? null, pass: pass?.id ?? null }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('formdetect — field detection harness (Spike 0)', () => {
  it('standard: explicit name/id on both fields', () => {
    expect(detect(loadForm('standard'))).toEqual({ user: 'username', pass: 'password' })
  })

  it('email + current-password: prefers current-password over new-password', () => {
    expect(detect(loadForm('email-currentpw'))).toEqual({ user: 'email', pass: 'pw' })
  })

  it('dynamic ids: falls back to the text field preceding the password', () => {
    expect(detect(loadForm('dynamic-ids'))).toEqual({ user: 'input_7xk2m', pass: 'input_9zp01' })
  })

  it('search decoy: site search box is not taken as the username', () => {
    expect(detect(loadForm('search-decoy'))).toEqual({ user: 'user', pass: 'pass' })
  })

  it('hidden/disabled decoys: honeypot + disabled fields are ignored', () => {
    expect(detect(loadForm('hidden-fields'))).toEqual({ user: 'real-user', pass: 'pass' })
  })

  it('password-only step: finds the password, no username (cross-doc pairing is background-side)', () => {
    expect(detect(loadForm('password-only'))).toEqual({ user: null, pass: 'pass' })
  })

  it('label heuristics: <label for> text identifies the username when ids/position do not', () => {
    // Without labels the positional fallback would wrongly pick f_b2 (the field just
    // before the password); the "Work email" label makes f_a1 win at the hint step.
    expect(detect(loadForm('labelled-fields'))).toEqual({ user: 'f_a1', pass: 'f_c3' })
  })

  it('no login form: detects nothing without throwing', () => {
    document.body.innerHTML = '<form><input type="text" name="q" placeholder="Search"></form>'
    expect(detect(document)).toEqual({ user: null, pass: null })
  })
})

describe('real-site burn-in (Spike 4) — detection against captured markup', () => {
  // Faithful fixtures scraped from live, server-rendered login pages. Detection-only
  // (live fill/capture still needs the browser). When a real site mis-detects, drop
  // its markup here as a fixture and add a row — that's the burn-in feedback loop.
  it('github.com/login — explicit autocomplete wins over spam honeypots', () => {
    expect(detect(loadForm('realsites/github-login'))).toEqual({ user: 'login_field', pass: 'password' })
  })

  it('gitlab.com/users/sign_in — bracketed names, remember-me checkbox ignored', () => {
    expect(detect(loadForm('realsites/gitlab-login'))).toEqual({ user: 'user_login', pass: 'user_password' })
  })

  it('wikipedia Special:UserLogin — search-box decoy + multi-token autocomplete', () => {
    expect(detect(loadForm('realsites/wikipedia-login'))).toEqual({ user: 'wpName1', pass: 'wpPassword1' })
  })

  it('stackoverflow.com/users/login — email field + current-password, signup modal hidden', () => {
    expect(detect(loadForm('realsites/stackoverflow-login'))).toEqual({ user: 'email', pass: 'password' })
  })

  it('twitch.tv/login — SPA form, autocomplete=username wins', () => {
    expect(detect(loadForm('realsites/twitch-login'))).toEqual({ user: 'login-username', pass: 'password-input' })
  })
})

describe('hostile fields — section 6 of AUTOFILL_REGRESSION.md', () => {
  it('OTP/2FA code field after login is not captured as username', () => {
    // A page that shows a password + OTP field (but no username field).
    // The OTP must not be mistaken for a username by the positional fallback.
    document.body.innerHTML = `
      <form>
        <input type="password" id="pw">
        <input type="text" id="otp" name="otp" placeholder="6-digit code" autocomplete="one-time-code">
      </form>`
    expect(detect(document)).toEqual({ user: null, pass: 'pw' })
  })

  it('2fa name variant is also rejected', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" id="code" name="2fa_code">
        <input type="password" id="pw">
      </form>`
    expect(detect(document)).toEqual({ user: null, pass: 'pw' })
  })

  it('captcha field is not taken as username', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" id="cap" name="captcha_answer">
        <input type="password" id="pw">
      </form>`
    expect(detect(document)).toEqual({ user: null, pass: 'pw' })
  })
})

describe('autocomplete tokenization (Spike 4 finding)', () => {
  it('matches a multi-token autocomplete when nothing else identifies the field', () => {
    // Only the `username` token marks the user: ids carry no hint, and a second text
    // field sits between it and the password so the positional fallback would miss.
    document.body.innerHTML = `
      <form>
        <input id="u" type="text" autocomplete="username webauthn">
        <input id="x" type="text">
        <input id="p" type="password" autocomplete="current-password">
      </form>`
    expect(detect(document)).toEqual({ user: 'u', pass: 'p' })
  })
})

describe('labelText', () => {
  it('reads <label for>, wrapping <label>, and aria-labelledby', () => {
    document.body.innerHTML = `
      <label for="a">Email address</label><input id="a" type="text">
      <label>Username <input id="b" type="text"></label>
      <span id="lbl">Account name</span><input id="c" type="text" aria-labelledby="lbl">`
    const byId = (id: string) => document.getElementById(id) as HTMLInputElement
    expect(labelText(byId('a'))).toContain('Email address')
    expect(labelText(byId('b'))).toContain('Username')
    expect(labelText(byId('c'))).toContain('Account name')
  })
})

describe('isVisible', () => {
  it('rejects hidden, disabled, and type=hidden inputs', () => {
    document.body.innerHTML = `
      <input id="a" type="text">
      <input id="b" type="text" hidden>
      <input id="c" type="text" disabled>
      <input id="d" type="hidden">
      <input id="e" type="text" style="display:none">`
    const byId = (id: string) => document.getElementById(id) as HTMLInputElement
    expect(isVisible(byId('a'))).toBe(true)
    expect(isVisible(byId('b'))).toBe(false)
    expect(isVisible(byId('c'))).toBe(false)
    expect(isVisible(byId('d'))).toBe(false)
    expect(isVisible(byId('e'))).toBe(false)
  })
})

describe('per-frame detection (Spike 1 — iframe fill)', () => {
  // With `all_frames`, our script runs inside each iframe and detects against that
  // frame's own document. A cross-origin frame can't be read from the parent, so
  // this models what the injected per-frame instance does: detect on its own root.
  it('detects a login form inside an iframe document, treated as its own root', () => {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const doc = frame.contentDocument as Document
    doc.body.innerHTML = `
      <form>
        <input type="text" id="frame-user" name="username">
        <input type="password" id="frame-pass">
      </form>`
    expect(detect(doc)).toEqual({ user: 'frame-user', pass: 'frame-pass' })
  })

  it('does not see fields that live only in a child frame from the parent root', () => {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const doc = frame.contentDocument as Document
    doc.body.innerHTML = '<input type="password" id="frame-pass">'
    // The parent document has no fields of its own — only the frame does.
    expect(detect(document)).toEqual({ user: null, pass: null })
  })
})

describe('shadow DOM piercing (Spike 2)', () => {
  it('finds a login form inside an open shadow root', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    host.attachShadow({ mode: 'open' }).innerHTML = `
      <form>
        <input type="text" id="shadow-user" name="username">
        <input type="password" id="shadow-pass">
      </form>`
    expect(detect(document)).toEqual({ user: 'shadow-user', pass: 'shadow-pass' })
  })

  it('finds fields nested in a shadow root within a shadow root', () => {
    const outer = document.createElement('div')
    document.body.appendChild(outer)
    const outerRoot = outer.attachShadow({ mode: 'open' })
    const inner = document.createElement('div')
    outerRoot.appendChild(inner)
    inner.attachShadow({ mode: 'open' }).innerHTML = `
      <input type="email" id="nested-user" autocomplete="username">
      <input type="password" id="nested-pass" autocomplete="current-password">`
    expect(detect(document)).toEqual({ user: 'nested-user', pass: 'nested-pass' })
  })

  it('cannot see fields inside a CLOSED shadow root (documented limit)', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    // Closed roots are inaccessible to any script — `host.shadowRoot` is null.
    host.attachShadow({ mode: 'closed' }).innerHTML =
      '<input type="text" id="closed-user"><input type="password" id="closed-pass">'
    expect(detect(document)).toEqual({ user: null, pass: null })
  })
})

describe('form classification — sign-up vs login vs change (registration assist)', () => {
  it('standard login form classifies as login', () => {
    expect(classifyForm(loadForm('standard'))).toBe('login')
  })

  it('sign-up form with autocomplete="new-password" classifies as signup', () => {
    expect(classifyForm(loadForm('signup-autocomplete'))).toBe('signup')
  })

  it('two-password sign-up with no autocomplete classifies as signup (count rule)', () => {
    expect(classifyForm(loadForm('signup-2pw'))).toBe('signup')
  })

  it('change-password form (current+new+confirm) classifies as change, not signup', () => {
    expect(classifyForm(loadForm('change-3pw'))).toBe('change')
  })

  it('three-password change form with no autocomplete classifies as change (count rule)', () => {
    expect(classifyForm(loadForm('change-3pw-noac'))).toBe('change')
  })

  it('single-password sign-up is rescued by keyword hints', () => {
    expect(classifyForm(loadForm('signup-1pw-keyword'))).toBe('signup')
  })

  it('a password-less newsletter form is never a sign-up', () => {
    expect(classifyForm(loadForm('newsletter-single'))).toBe('unknown')
  })

  it('a current-password field present alongside new-password is change, never signup', () => {
    // The mixed-field decoy: having a current-password means we must NOT treat it as a
    // fresh sign-up and offer to overwrite with a generated password.
    expect(classifyForm(loadForm('email-currentpw'))).toBe('change')
  })

  it('a plain current-password-only login classifies as login', () => {
    expect(classifyForm(loadForm('standard'))).toBe('login')
  })
})

describe('new-password + confirm field detection', () => {
  it('targets the new-password field on an annotated sign-up form', () => {
    expect(findNewPasswordField(loadForm('signup-autocomplete'))?.id).toBe('su-pass')
  })

  it('skips the current-password field on a change form (fills the new one)', () => {
    expect(findNewPasswordField(loadForm('change-3pw'))?.id).toBe('cp-new')
  })

  it('pairs the confirm field that follows the new-password field', () => {
    const root = loadForm('signup-autocomplete')
    const newPw = findNewPasswordField(root)!
    expect(findConfirmField(root, newPw)?.id).toBe('su-confirm')
  })

  it('pairs the confirm field by position when there is no autocomplete', () => {
    const root = loadForm('signup-2pw')
    const newPw = findNewPasswordField(root)!
    expect(newPw.id).toBe('su2-pass')
    expect(findConfirmField(root, newPw)?.id).toBe('su2-confirm')
  })

  it('returns no confirm field for a single-password sign-up', () => {
    const root = loadForm('signup-1pw-keyword')
    const newPw = findNewPasswordField(root)!
    expect(findConfirmField(root, newPw)).toBeNull()
  })
})

describe('isEmailLikeField (email autofill safety)', () => {
  const input = (html: string): HTMLInputElement => {
    document.body.innerHTML = html
    return document.querySelector('input')!
  }

  it('true for type=email', () => {
    expect(isEmailLikeField(input('<input type="email">'))).toBe(true)
  })

  it('true for an email autocomplete token', () => {
    expect(isEmailLikeField(input('<input type="text" autocomplete="email">'))).toBe(true)
  })

  it('true when name/id/placeholder mentions email', () => {
    expect(isEmailLikeField(input('<input type="text" name="user_email">'))).toBe(true)
    expect(isEmailLikeField(input('<input type="text" placeholder="Your e-mail">'))).toBe(true)
  })

  it('false for a plain username field (do not drop an email into it)', () => {
    expect(isEmailLikeField(input('<input type="text" name="username" placeholder="Choose a username">'))).toBe(false)
  })
})
