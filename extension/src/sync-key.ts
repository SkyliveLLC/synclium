// The sync key: 256 random bits every device in one sync folder shares. The first device mints it, the user
// pastes it on the others, and it never enters the folder. Files carry only `keyId`, a fingerprint derived from
// it, so a reader tells "sealed with another key" apart from "torn".
//
// Derivation: HKDF-SHA256 over the key, one `info` per purpose. AES-256-GCM seals file bodies; the key id is 64
// bits, enough to tell sync groups apart and useless for guessing the key.
import type { Brand } from './model.ts';
import type { Cipher } from './store-format.ts';

/** 52 Crockford base32 digits, uppercase, no separators: 256 bits and 4 zero bits. The form DeviceLocal holds. */
export type SyncKey = Brand<string, 'SyncKey'>;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_BYTES = 32;
const DIGITS = 52;
const PREFIX = 'HSK';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const utf8 = new TextEncoder();

function toDigits(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xfff; // under 5 bits carried in, plus 8
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** Digits already checked against ALPHABET. Trailing pad bits are dropped; `parseSyncKey` rejects nonzero ones. */
function toBytes(digits: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(KEY_BYTES);
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const digit of digits) {
    acc = ((acc << 5) | ALPHABET.indexOf(digit)) & 0x1fff; // under 8 bits carried in, plus 5
    bits += 5;
    if (bits >= 8 && at < KEY_BYTES) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

export function mintSyncKey(): SyncKey {
  const key = parseSyncKey(toDigits(crypto.getRandomValues(new Uint8Array(KEY_BYTES))));
  if (key === null) throw new Error('minted an unparseable sync key');
  return key;
}

/**
 * The key a user pasted or typed. Forgiving about what people do to codes: case, spaces, dashes, the `HSK`
 * prefix, and O/I/L for 0/1. Null for anything that is not exactly one key.
 */
export function parseSyncKey(text: string): SyncKey | null {
  let digits = text.toUpperCase().replace(/[\s-]/g, '');
  if (digits.length === PREFIX.length + DIGITS && digits.startsWith(PREFIX)) digits = digits.slice(PREFIX.length);
  digits = digits.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (digits.length !== DIGITS || [...digits].some((d) => !ALPHABET.includes(d))) return null;
  const isCanonical = (d: string): d is SyncKey => toDigits(toBytes(d)) === d;
  return isCanonical(digits) ? digits : null;
}

/** `HSK-XXXX-XXXX-…`, 13 groups. What setup shows and the user saves. */
export function formatSyncKey(key: SyncKey): string {
  return [PREFIX, ...(key.match(/.{4}/g) ?? [])].join('-');
}

/** The AES-256-GCM cipher for a key. Sealed bytes are iv ‖ ciphertext ‖ tag; `aad` is authenticated, not stored. */
export async function cipherFor(key: SyncKey): Promise<Cipher> {
  const master = await crypto.subtle.importKey('raw', toBytes(key), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const purpose = (info: string): HkdfParams => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(info) });
  const aes = await crypto.subtle.deriveKey(purpose('helium-sync file key v1'), master, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const id = new Uint8Array(await crypto.subtle.deriveBits(purpose('helium-sync key id v1'), master, 64));
  return {
    keyId: [...id].map((b) => b.toString(16).padStart(2, '0')).join(''),
    async seal(plain, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array(aad) }, aes, new Uint8Array(plain)));
      const out = new Uint8Array(IV_BYTES + sealed.length);
      out.set(iv, 0);
      out.set(sealed, IV_BYTES);
      return out;
    },
    async open(sealed, aad) {
      if (sealed.length < IV_BYTES + TAG_BYTES) return null;
      try {
        const iv = new Uint8Array(sealed.subarray(0, IV_BYTES));
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array(aad) }, aes, new Uint8Array(sealed.subarray(IV_BYTES))));
      } catch {
        return null; // wrong tag: tampered, torn, or moved from another path
      }
    },
  };
}
