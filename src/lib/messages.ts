/** Typed message protocol between popup / content scripts and the background worker. */

import type { VaultEntry } from './vault'

export type Request =
  | { type: 'status' }
  | { type: 'create'; masterPassword: string }
  | { type: 'unlock'; masterPassword: string }
  // Re-verify the master password without changing lock state — gates revealing a
  // saved password in the UI (shoulder-surf / unattended-popup protection).
  | { type: 'verifyMaster'; masterPassword: string }
  | { type: 'lock' }
  // Recovery phrase (v0.3): generate/replace the BIP39 phrase, and reset the master
  // password using either the old password or the recovery phrase as `currentSecret`.
  | { type: 'setupRecovery'; currentSecret: string }
  | { type: 'hasRecovery' }
  | { type: 'changeMaster'; currentSecret: string; newMasterPassword: string }
  // Encrypted backup: export entries under an export password; import merges them back.
  | { type: 'exportVault'; exportPassword: string }
  | { type: 'importVault'; json: string; exportPassword: string }
  // Biometric unlock (WebAuthn PRF). prfOutput/credentialId are base64 from the popup.
  | { type: 'biometricInfo' } // works while locked
  | { type: 'addBiometric'; currentSecret: string; prfOutput: string; credentialId: string }
  | { type: 'unlockBiometric'; prfOutput: string }
  | { type: 'removeBiometric' }
  | { type: 'list' }
  | { type: 'add'; entry: Omit<VaultEntry, 'id' | 'createdAt' | 'updatedAt'> }
  | { type: 'update'; entry: VaultEntry }
  | { type: 'delete'; id: string }
  | { type: 'matchForHost'; hostname: string }
  // Cross-document multi-step login: the username typed on one full-navigation page
  // is remembered in the worker (keyed by registrable domain, TTL'd) so the
  // password-only page that follows can be captured with the right account.
  | { type: 'rememberUsername'; hostname: string; username: string }
  // Capture-on-submit: content script offers to save/update after a login.
  | { type: 'capturePending'; hostname: string; username: string; password: string }
  | { type: 'pendingFor'; hostname: string }
  | { type: 'captureConfirm'; hostname: string }
  | { type: 'captureDismiss'; hostname: string }
  | { type: 'deleteVault' }

export interface StatusResponse {
  exists: boolean
  unlocked: boolean
}

/** What the content-script banner needs — never includes the password. */
export interface PendingInfo {
  action: 'save' | 'update' | 'none'
  hostname: string
  username: string
  title?: string
}

export type Response<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export function sendMessage<T = unknown>(req: Request): Promise<Response<T>> {
  return chrome.runtime.sendMessage(req) as Promise<Response<T>>
}
