/**
 * WebAuthn biometric unlock via the PRF extension (browser-only — runs in the popup,
 * not the service worker, since `navigator.credentials` is a document API).
 *
 * Flow: a platform authenticator (Windows Hello / Touch ID) holds a discoverable
 * credential. Its PRF output for a fixed app salt is high-entropy and stable, so we
 * feed it to HKDF (`deriveKeyFromEntropy`) to wrap the same vault key as every other
 * unlock method — additive on the v0.3 key-wrapping model. The PRF bytes are returned
 * base64 and handed to the background to (un)wrap; they never persist.
 *
 * Not unit-tested (needs a real authenticator). Verify by loading the unpacked
 * extension. RP id is the extension origin's host (`location.hostname`); Chrome
 * accepts the extension id as the relying-party id for extension-origin WebAuthn.
 */

import { fromBase64, toBase64 } from './crypto'

const RP_NAME = 'Pass123'
// Fixed PRF evaluation salt: the PRF output is keyed by (credential, salt), and the
// credential is already unique per device, so a constant salt is sufficient.
const PRF_SALT = new TextEncoder().encode('pass123-prf-v1')

export interface BiometricEnrollment {
  /** base64url WebAuthn credential id (passed back to navigator.credentials.get). */
  credentialId: string
  /** base64 PRF output used to wrap the vault key. */
  prfOutput: string
}

export function isWebAuthnAvailable(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials
}

/** Is a user-verifying platform authenticator (Hello / Touch ID) present? */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnAvailable()) return false
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/** Create a platform credential with PRF and return its id + PRF output. */
export async function enrollBiometric(): Promise<BiometricEnrollment> {
  if (!isWebAuthnAvailable()) throw new Error('WebAuthn is not available here')
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: RP_NAME, id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'Pass123 Vault',
        displayName: 'Pass123 Vault',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'required',
      },
      timeout: 60_000,
      extensions: { prf: { eval: { first: PRF_SALT as BufferSource } } },
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('Biometric enrollment was cancelled')

  const prf = cred.getClientExtensionResults().prf
  if (!prf?.enabled) {
    throw new Error('This device can’t encrypt the vault with biometrics (no PRF support).')
  }
  const credentialId = toBase64Url(new Uint8Array(cred.rawId))
  // Some authenticators return the PRF output on create(); others only on get().
  const prfOutput = prf.results?.first
    ? toBase64(toBytes(prf.results.first))
    : await getBiometricPRF(credentialId)
  return { credentialId, prfOutput }
}

/** Run a biometric assertion for `credentialId` and return its base64 PRF output. */
export async function getBiometricPRF(credentialId: string): Promise<string> {
  if (!isWebAuthnAvailable()) throw new Error('WebAuthn is not available here')
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) as BufferSource }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: PRF_SALT as BufferSource } } },
    },
  })) as PublicKeyCredential | null
  if (!assertion) throw new Error('Biometric check was cancelled')
  const first = assertion.getClientExtensionResults().prf?.results?.first
  if (!first) throw new Error('Biometric PRF output unavailable')
  return toBase64(toBytes(first))
}

/** Normalize a BufferSource (ArrayBuffer or view) to a Uint8Array. */
function toBytes(src: BufferSource): Uint8Array {
  return src instanceof ArrayBuffer
    ? new Uint8Array(src)
    : new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
}

// base64url for credential ids (WebAuthn convention); reuse base64 for PRF bytes.
function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}
