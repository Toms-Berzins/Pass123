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
import { findPasswordField, findUsernameField, isVisible, labelText } from './formdetect'

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
