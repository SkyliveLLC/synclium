// What setup binds: the store the device talks to, how to grant the extension access to it, and the
// pairing code that carries it to the next device. The only module that knows the shape of a credential.
import type { Store } from '../ports.ts';
import type { Brand } from '../model.ts';

/** `https://` or `http://` collection URL ending in `/`. Minted only by `parseStoreUrl`. http is allowed for LAN NAS boxes; the UI warns. */
export type StoreUrl = Brand<string, 'StoreUrl'>;
export function parseStoreUrl(_input: string): StoreUrl | { readonly error: 'not-a-url' | 'not-http' } {
  throw new Error('not implemented');
}

/**
 * v1 ships WebDAV only. The next member is `{ kind: 's3'; endpoint; region; bucket; prefix; accessKey; secretKey }`
 * in adapters/s3-store.ts; every switch on `kind` fails to compile until it is handled.
 */
export type StoreConfig = {
  readonly kind: 'webdav';
  /** The helium-sync folder itself, e.g. https://cloud.example.com/remote.php/dav/files/conan/helium-sync/ */
  readonly url: StoreUrl;
  readonly username: string;
  /** An app password where the provider has them. Stored in chrome.storage.local, plaintext (v1 has no encryption at rest). */
  readonly password: string;
};

export function storeFor(_config: StoreConfig): Store {
  // switch (config.kind) { case 'webdav': return webdavStore(config) }  exhaustive
  throw new Error('not implemented');
}

// ---------- Provider presets (setup form only) ----------

/** Turns "server + username" into the DAV collection URL so the user never types /remote.php/dav/files/... */
export type Preset = {
  readonly id: 'nextcloud' | 'owncloud' | 'synology' | 'fastmail' | 'hetzner-storagebox' | 'koofr' | 'pcloud' | 'other-webdav';
  readonly label: string;
  /** Where the app password lives, shown as a link under the password field. */
  readonly appPasswordHelp: string | null;
  url(server: string, username: string): string;
};
export const presets: readonly Preset[] = [];

// ---------- Host permission ----------

// `optional_host_permissions` in the manifest is the https and http wildcard (`https://` + `*` + `/*`, and the http twin);
// the runtime grant is narrowed to the store's origin, e.g. `https://cloud.example.com/*`.
export function originPattern(_url: StoreUrl): string {
  throw new Error('not implemented');
}

/**
 * Must run inside a user gesture (the Connect or Join click) or Chrome rejects the request without a prompt.
 * Idempotent: `permissions.contains` first. The service worker calls the `contains` half before every
 * fetch so a grant the user revoked in chrome://extensions shows as `no-host-permission`, not as a CORS error.
 */
export function requestHostPermission(_url: StoreUrl): Promise<'granted' | 'denied'> {
  throw new Error('not implemented');
}
export function hasHostPermission(_url: StoreUrl): Promise<boolean> {
  throw new Error('not implemented');
}

// ---------- Pairing code ----------

/**
 * `helium-sync:1:<base64url(canonical JSON StoreConfig)>`. Device 1 shows it with a Copy button; device 2
 * pastes it and clicks Join. It carries the credential, so the UI says so in one sentence and offers a
 * "without password" variant that leaves the password field for device 2 to fill.
 *
 * Why no QR: Helium is desktop-only, and a desktop has no camera a user points at another desktop.
 * BarcodeDetector exists in Chromium on macOS only. The string is what moves between machines, through
 * the password manager or a note-to-self, and it is short enough to paste. A QR renderer later is a
 * presentation of the same string.
 */
export type PairingCode = Brand<string, 'PairingCode'>;

export function encodePairing(_config: StoreConfig, _opts: { readonly includeSecret: boolean }): PairingCode {
  throw new Error('not implemented');
}

export type ParsedPairing =
  | { readonly kind: 'ok'; readonly config: StoreConfig; readonly needsPassword: boolean }
  | { readonly kind: 'invalid'; readonly why: 'not-a-pairing-code' | 'newer-version' | 'bad-config' };

/** Boundary parse. Never throws. Re-validates the URL and every field. */
export function parsePairing(_text: string): ParsedPairing {
  throw new Error('not implemented');
}
