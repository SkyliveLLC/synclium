// Key custody and device pairing. Holds the vault key; hands out seal/open, never the key.
import type { DeviceId, StoreKey, VaultId } from "./ids.ts";
import type { Clock, SecretStore, Store } from "./ports.ts";
import type { DeviceMeta } from "./envelope.ts";

/** What the engine sees. Keys stay inside. */
export interface Vault {
  readonly id: VaultId;
  readonly device: DeviceId;
  readonly epoch: number;
  seal(at: StoreKey, json: unknown): Uint8Array;
  /** null = unauthenticated or unknown epoch. Callers keep the last good copy. */
  open(at: StoreKey, bytes: Uint8Array): unknown | null;
  roster(): Promise<readonly DeviceMeta[]>;
}

/**
 * Pairing token, shown once, typed or pasted on the new device. 128-bit random secret, so no PAKE
 * and no dependency: `hsync1.<vaultId>.<secret, Crockford base32, 26 chars>`.
 * The folder holds invites/<id> = vaultKey sealed under HKDF(secret). Cloud never sees the secret.
 */
export type InviteToken = string & { readonly __invite: true };

export interface Deps { store: Store; secrets: SecretStore; clock: Clock }

/**
 * First device. Generates the vault key, writes vault.json + own meta, stores the key in SecretStore.
 * Returns a recovery key (the vault key, base32) to print once; losing every device without it loses the vault.
 * Idempotent: re-running on an initialised folder opens it instead of making a second vault.
 */
export function createVault(_deps: Deps, _device: { name: string }): Promise<{ vault: Vault; recoveryKey: string }> {
  throw new Error("not implemented");
}

/** Existing device, after createVault/joinVault. Throws if the SecretStore has no key for this folder's vaultId. */
export function openVault(_deps: Deps): Promise<Vault> {
  throw new Error("not implemented");
}

/** Existing device -> token. Writes the sealed invite with an expiry (default 15 min, enforced by clients, best effort). */
export function issueInvite(_vault: Vault, _deps: Deps, _opts?: { ttlMs?: number }): Promise<InviteToken> {
  throw new Error("not implemented");
}

/**
 * New device. Reads invites/<id> derived from the token, decrypts the vault key, generates a device id
 * and X25519 key, stores both in SecretStore, writes own meta (with joinedVia = invite id).
 * Any device deletes the invite once the joiner's meta appears (single use, best effort; the
 * token is the secret, so a lingering ciphertext is useless without it).
 * Idempotent: a half-finished join (key stored, meta not written) resumes.
 */
export function joinVault(_deps: Deps, _token: InviteToken | string, _device: { name: string }): Promise<Vault> {
  throw new Error("not implemented");
}

/** Join with the recovery key instead of an invite (all devices lost). */
export function joinWithRecoveryKey(_deps: Deps, _recoveryKey: string, _device: { name: string }): Promise<Vault> {
  throw new Error("not implemented");
}

/**
 * Real revocation. New vault key (epoch+1), sealed to the X25519 key of every remaining device at
 * epochs/<n>/<dev>; state files are re-sealed by their own devices on their next sync.
 * The revoked device keeps the old key (and can read old data) but nothing written after the rotation.
 * Format and epoch handling ship in v1; the command can land in v1.1.
 */
export function rotate(_vault: Vault, _deps: Deps, _revoke: readonly DeviceId[]): Promise<Vault> {
  throw new Error("not implemented");
}
