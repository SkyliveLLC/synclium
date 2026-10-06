// Store layout + the encrypted wire format. The ONLY module that knows key names and byte layout.
import type { DeviceId, Hlc, StoreKey, TypeId, VaultId } from "./ids.ts";

/**
 * Store layout. Every key has one writer, so dumb folders never see a write-write conflict.
 *
 *   helium-sync/vault.json                      plaintext header { format, vaultId, epoch }  (init only)
 *   helium-sync/devices/<dev>/meta              sealed DeviceMeta     (written by <dev>)
 *   helium-sync/devices/<dev>/<type>/<shard>    sealed StateFile      (written by <dev>; shard "_" until a type needs more)
 *   helium-sync/invites/<inviteId>              sealed under the invite secret, not the vault key
 *   helium-sync/epochs/<n>/<dev>                vault key epoch n sealed to <dev>'s X25519 key (rotation)
 */
export const keys = {
  header: (): StoreKey => { throw new Error("not implemented"); },
  meta: (_d: DeviceId): StoreKey => { throw new Error("not implemented"); },
  state: (_d: DeviceId, _t: TypeId, _shard = "_"): StoreKey => { throw new Error("not implemented"); },
  invite: (_id: string): StoreKey => { throw new Error("not implemented"); },
  epoch: (_n: number, _d: DeviceId): StoreKey => { throw new Error("not implemented"); },
  /** Strict parse. Dropbox "(conflicted copy)", Syncthing tmp files and iCloud placeholders return null and are ignored. */
  parse: (_key: string): ParsedKey | null => { throw new Error("not implemented"); },
  /** The only device allowed to have written this key; engine drops files whose content says otherwise. */
  owner: (_key: StoreKey): DeviceId | null => { throw new Error("not implemented"); },
};
export type ParsedKey =
  | { kind: "meta"; device: DeviceId }
  | { kind: "state"; device: DeviceId; type: TypeId; shard: string }
  | { kind: "invite"; id: string };

/** Plaintext (post-decrypt, post-gunzip) body of devices/<dev>/<type>/<shard>. */
export interface StateFile<State = unknown> {
  device: DeviceId;
  typeVersion: number;
  /** Monotonic per device+type. A lower seq than already seen means the cloud served stale data. */
  seq: number;
  at: Hlc;
  /** "I have merged everything from device X up to this stamp." Drives tombstone GC and eviction. */
  acked: Readonly<Record<DeviceId, Hlc>>;
  state: State;
}

export interface DeviceMeta {
  device: DeviceId;
  name: string;
  /** X25519 public key; used only to wrap a rotated vault key to this device. */
  publicKey: string;
  joinedAt: number;
  joinedVia: string; // invite id, "recovery", or "init"
  app: { name: string; version: string };
}

/**
 * Envelope: "HSY1" | epoch u32 | salt[16] | nonce[12] | AES-256-GCM(gzip(json)) | tag.
 * Per-file key = HKDF-SHA256(vaultKey[epoch], salt, "helium-sync/file").
 * AAD = magic | vaultId | epoch | store key. Cloud cannot move a blob to another path, replay it
 * under another vault, or flip the epoch without failing authentication.
 * Raw primitives; callers use Vault.seal/open, which hold the key.
 */
export function sealBytes(_i: { key: Uint8Array; vault: VaultId; epoch: number; at: StoreKey; plaintext: Uint8Array }): Uint8Array {
  throw new Error("not implemented");
}
export function openBytes(_i: { keyFor(epoch: number): Uint8Array | null; vault: VaultId; at: StoreKey; bytes: Uint8Array }): Uint8Array | null {
  // null = cannot authenticate (partial upload, unknown epoch, tamper). Never throws on bad input.
  throw new Error("not implemented");
}
