/**
 * Login-form field detection — the pure, root-parameterized core of the autofill
 * moat (see docs/AUTOFILL_SPIKES.md). Extracted from `content.ts` so it is
 * unit-testable (Spike 0) and so the same traversal can later descend shadow roots
 * (Spike 2) and iframes (Spike 1) just by passing a different root.
 *
 * Every entry point takes an explicit `root` (`Document | ShadowRoot | Element`)
 * instead of touching a global `document`. The content script passes `document`;
 * tests pass a happy-dom document; future spikes pass shadow roots / frame docs.
 */

const USER_HINT = /user|email|login|account|phone|mobile|nick/i
const NON_USER_HINT = /search|query|otp|code|totp|2fa|captcha/i

/** All the identifying text on a field, lower-cased, for heuristic matching. */
export function fieldText(el: HTMLInputElement): string {
  return `${el.name} ${el.id} ${el.getAttribute('aria-label') ?? ''} ${el.placeholder} ${el.autocomplete}`
}

/**
 * `autocomplete` can carry several space-separated tokens (e.g. Wikipedia ships
 * `autocomplete="username webauthn"`), so an exact `=== 'username'` test misses it.
 * Split into tokens and match membership. Real-site finding (Spike 4 burn-in).
 */
export function autocompleteTokens(el: HTMLInputElement): string[] {
  return (el.autocomplete || '').toLowerCase().split(/\s+/).filter(Boolean)
}

function escapeId(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(id)
  return id.replace(/["\\]/g, '\\$&')
}

/**
 * Visible label text associated with a field — `<label for>`, a wrapping `<label>`,
 * and `aria-labelledby`. This is the signal that survives framework-mangled
 * name/id attributes (`input_7xk2m`): the *label* still says "Email". Resolved
 * within the field's own root, so it works inside shadow trees too.
 */
export function labelText(el: HTMLInputElement): string {
  const parts: string[] = []
  const root = el.getRootNode() as Document | ShadowRoot
  if (el.id && 'querySelectorAll' in root) {
    for (const l of root.querySelectorAll(`label[for="${escapeId(el.id)}"]`)) {
      parts.push(l.textContent ?? '')
    }
  }
  const wrapping = el.closest?.('label')
  if (wrapping) parts.push(wrapping.textContent ?? '')
  const labelledby = el.getAttribute('aria-labelledby')
  if (labelledby && 'getElementById' in root) {
    for (const id of labelledby.split(/\s+/)) {
      const ref = root.getElementById(id)
      if (ref) parts.push(ref.textContent ?? '')
    }
  }
  return parts.join(' ')
}

/** Field attributes + associated label text — the full haystack for name heuristics. */
function hintHaystack(el: HTMLInputElement): string {
  return `${fieldText(el)} ${labelText(el)}`
}

/**
 * True when the document actually computes layout. Real browsers do; the
 * headless DOMs used in tests (happy-dom/jsdom) do not — there `offsetParent` is
 * always null and `getClientRects()` is always empty, which would hide every
 * field. We detect that once via the body and only apply the layout filter when
 * layout is real.
 */
function layoutAvailable(doc: Document | null | undefined): boolean {
  const body = doc?.body
  return !!body && body.getClientRects().length > 0
}

/** Walk self + ancestors for a CSS/`hidden` reason the element isn't shown. Layout-free. */
function styleHidden(el: HTMLElement): boolean {
  const win = el.ownerDocument?.defaultView
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.hidden) return true
    if (n.style && (n.style.display === 'none' || n.style.visibility === 'hidden')) return true
    const s = win?.getComputedStyle(n)
    if (s && (s.display === 'none' || s.visibility === 'hidden')) return true
  }
  return false
}

/** Skip fields the user can't actually be logging in with (hidden, disabled, off-screen). */
export function isVisible(el: HTMLInputElement): boolean {
  if (el.hidden || el.disabled || el.type === 'hidden') return false
  if (styleHidden(el)) return false
  // In a real browser also require layout (catches off-screen / zero-box / ancestor
  // display:none). In a no-layout env this signal is meaningless, so we skip it.
  if (layoutAvailable(el.ownerDocument)) {
    return el.offsetParent !== null || el.getClientRects().length > 0
  }
  return true
}

/**
 * Cap on elements scanned while piercing shadow roots, so a pathological page
 * can't make detection hang. Far above any real login page's node count.
 */
const DEEP_SCAN_BUDGET = 20000

/**
 * Like `querySelectorAll`, but descends into **open** shadow roots (Spike 2).
 * Web-component login forms (and many design-system inputs) live inside a shadow
 * root, where a flat `querySelectorAll` can't see them. Closed shadow roots are
 * inaccessible to any script — that's a documented limit, same as every manager.
 *
 * The light DOM is matched natively (fast path); we only recurse where a host
 * actually has a shadow root. Matches come out light-DOM-first, then per-host
 * shadow matches — close enough to document order for the field heuristics, since
 * a given login form's fields almost always share one root.
 */
function deepQuerySelectorAll<E extends Element>(
  root: ParentNode,
  selector: string,
  budget = { n: DEEP_SCAN_BUDGET },
): E[] {
  const out = [...root.querySelectorAll<E>(selector)]
  for (const host of root.querySelectorAll('*')) {
    if (budget.n-- <= 0) break
    if (host.shadowRoot) out.push(...deepQuerySelectorAll<E>(host.shadowRoot, selector, budget))
  }
  return out
}

function inputs(root: ParentNode): HTMLInputElement[] {
  return deepQuerySelectorAll<HTMLInputElement>(root, 'input').filter(isVisible)
}

export function passwordFields(root: ParentNode): HTMLInputElement[] {
  return deepQuerySelectorAll<HTMLInputElement>(root, 'input[type="password"]').filter(isVisible)
}

export function findPasswordField(root: ParentNode, requireValue = false): HTMLInputElement | null {
  const fields = passwordFields(root)
  const isCurrent = (f: HTMLInputElement) => autocompleteTokens(f).includes('current-password')
  if (requireValue) {
    // The one the user actually typed into — prefer an explicit current-password.
    return fields.find((f) => f.value && isCurrent(f)) ?? fields.find((f) => f.value) ?? null
  }
  // For autofill, target the login (current-password) field over a new-password one.
  return fields.find(isCurrent) ?? fields[0] ?? null
}

/**
 * True if a field is an *email* input (not just any username) — `type=email`, an
 * `email` autocomplete token, or email wording in its attributes/label. Used to
 * decide whether it's safe to drop a stored email address into the field.
 */
export function isEmailLikeField(el: HTMLInputElement): boolean {
  if (el.type === 'email') return true
  if (autocompleteTokens(el).includes('email')) return true
  return /e-?mail/i.test(`${fieldText(el)} ${labelText(el)}`)
}

/** True if the field is explicitly tagged as a *new* password (sign-up / reset / change). */
export function isNewPasswordField(el: HTMLInputElement): boolean {
  return autocompleteTokens(el).includes('new-password')
}

/** True if the field is explicitly tagged as the *existing* password (sign-in / old password). */
function isCurrentPasswordField(el: HTMLInputElement): boolean {
  return autocompleteTokens(el).includes('current-password')
}

export type FormKind = 'login' | 'signup' | 'change' | 'unknown'

// Secondary, i18n-fragile keyword signals — only used to break ties on a lone,
// un-annotated password field, never to override an explicit autocomplete value.
const SIGNUP_HINT = /sign[\s-]?up|regist|create[\s-]?(an? )?account|create your account|\bjoin\b|get started|new account/i
const LOGIN_HINT = /sign[\s-]?in|log[\s-]?in|forgot|remember me/i

/** Visible button / heading / legend text under a root — a weak hint at the form's purpose. */
function formKeywords(root: ParentNode): string {
  const els = deepQuerySelectorAll<HTMLElement>(root, 'button, input[type="submit"], [role="button"], h1, h2, legend')
  return els.map((e) => (e as HTMLInputElement).value || e.textContent || '').join(' ').toLowerCase()
}

/**
 * Classify a form/root as login / signup / change / unknown — a faithful port of
 * the heuristics Chrome (`page_passwords_analyser.cc`) and Firefox
 * (`isProbablyANewPasswordField`) ship:
 *  1. `autocomplete` is authoritative: `new-password` ⇒ signup (or change if a
 *     `current-password` is also present); `current-password` alone ⇒ login.
 *  2. Otherwise fall back to the visible-password-field COUNT: 3+ ⇒ change
 *     (current+new+confirm), 2 ⇒ signup (new+confirm), 1 ⇒ login/unknown.
 *  3. A lone, un-annotated password field is the genuinely ambiguous case; only
 *     then do keyword hints decide, defaulting to the safe `login` so we never
 *     hijack a real sign-in field with a generated password.
 */
export function classifyForm(root: ParentNode): FormKind {
  const pw = passwordFields(root)
  if (pw.length === 0) return 'unknown'

  const hasNew = pw.some(isNewPasswordField)
  const hasCurrent = pw.some(isCurrentPasswordField)
  if (hasNew) return hasCurrent ? 'change' : 'signup'
  if (hasCurrent) return 'login'

  // No explicit autocomplete — Chromium's count heuristic.
  if (pw.length >= 3) return 'change'
  if (pw.length === 2) return 'signup'

  // Single un-annotated password field — the ambiguous case.
  const kw = formKeywords(root)
  const signup = SIGNUP_HINT.test(kw)
  const login = LOGIN_HINT.test(kw)
  if (signup && !login) return 'signup'
  if (login && !signup) return 'login'
  return findUsernameField(root, pw[0]) ? 'login' : 'unknown'
}

/**
 * The password field a generated password should go into:
 * the explicit `new-password` field, else (by the count rule) the first of the
 * last-two password fields — i.e. skip a leading current-password on a change form.
 */
export function findNewPasswordField(root: ParentNode): HTMLInputElement | null {
  const pw = passwordFields(root)
  if (pw.length === 0) return null
  const explicit = pw.find(isNewPasswordField)
  if (explicit) return explicit
  if (pw.length >= 3) return pw[pw.length - 2]
  return pw[0]
}

/** Max password fields to look past when pairing a confirm field (Firefox: MAX_CONFIRM_PASSWORD_DISTANCE). */
const MAX_CONFIRM_DISTANCE = 3

/**
 * The "confirm password" field paired with `newPw` (Firefox `findConfirmationField`):
 * the next password field after it, within a small distance, never a current-password.
 */
export function findConfirmField(root: ParentNode, newPw: HTMLInputElement): HTMLInputElement | null {
  const pw = passwordFields(root)
  const idx = pw.indexOf(newPw)
  if (idx === -1) return null
  for (let i = idx + 1; i < pw.length && i <= idx + MAX_CONFIRM_DISTANCE; i++) {
    if (!isCurrentPasswordField(pw[i])) return pw[i]
  }
  return null
}

export function findUsernameField(root: ParentNode, pw: HTMLInputElement | null): HTMLInputElement | null {
  const all = inputs(root)
  // 1. Explicit signal: autocomplete or an email field.
  const explicit = all.find((i) => {
    const ac = autocompleteTokens(i)
    return ac.includes('username') || ac.includes('email') || i.type === 'email'
  })
  if (explicit) return explicit
  // 2. Name/id/aria/placeholder/label hints, excluding search/OTP fields. The label
  //    text is what rescues framework-mangled ids where the attributes say nothing.
  const byHint = all.find(
    (i) =>
      (i.type === 'text' || i.type === 'tel' || i.type === '') &&
      USER_HINT.test(hintHaystack(i)) &&
      !NON_USER_HINT.test(hintHaystack(i)),
  )
  if (byHint) return byHint
  // 3. The visible text/email field immediately preceding the password.
  if (pw) {
    const idx = all.indexOf(pw)
    for (let i = idx - 1; i >= 0; i--) {
      const t = all[i].type
      if ((t === 'text' || t === 'email' || t === 'tel') && !NON_USER_HINT.test(hintHaystack(all[i]))) {
        return all[i]
      }
    }
  }
  return null
}
