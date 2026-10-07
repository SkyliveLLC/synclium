// Probes what the "<path>_encrypted_hash" siblings in protection.macs contain: OSCrypt-v10-decrypt each,
// then compare the 32 plaintext bytes against candidate digests of (device_id, path, value).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac, createHash } from 'node:crypto';
import { keyFor, decryptV10 } from './oscrypt.mjs';
import { ser } from './mac.mjs';
const dir = process.argv[2];
const secure = JSON.parse(readFileSync(`${dir}/Default/Secure Preferences`, 'utf8'));
const plain = JSON.parse(readFileSync(`${dir}/Default/Preferences`, 'utf8'));
const uuid = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }).match(/"IOPlatformUUID" = "([^"]+)"/)[1];
const get = (root, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), root);
const lookup = (path) => { const a = get(secure, path); return a !== undefined ? a : get(plain, path); };
const key = keyFor('mock_password');
const cands = (path, v) => ({
  hmacEmpty_dev: createHmac('sha256', '').update(uuid + path + ser(v)).digest(),
  hmacEmpty_nodev: createHmac('sha256', '').update(path + ser(v)).digest(),
  sha_dev: createHash('sha256').update(uuid + path + ser(v)).digest(),
  sha_nodev: createHash('sha256').update(path + ser(v)).digest(),
  sha_value: createHash('sha256').update(ser(v)).digest(),
  hmacUuidKey: createHmac('sha256', uuid).update(path + ser(v)).digest(),
});
const out = {};
const walk = (o, p) => { for (const [k, v] of Object.entries(o)) {
  if (k.endsWith('_encrypted_hash') && typeof v === 'string') { const path = (p ? p + '.' : '') + k.slice(0, -'_encrypted_hash'.length); out[path] = v; }
  else if (typeof v === 'object') walk(v, p ? `${p}.${k}` : k); } };
walk(secure.protection.macs, '');
// split prefs keep hashes under "<path>_encrypted_hash.<key>"
for (const [id, v] of Object.entries(secure.protection.macs.extensions?.settings_encrypted_hash ?? {})) out[`extensions.settings.${id}`] = v;
for (const k of Object.keys(out)) if (k.startsWith('extensions.settings_encrypted_hash')) delete out[k];
for (const [path, b64] of Object.entries(out)) {
  const pt = decryptV10(key, Buffer.from(b64, 'base64'));
  const hit = Object.entries(cands(path, lookup(path))).find(([, d]) => d.equals(pt));
  console.log(hit ? `OK   ${path} = ${hit[0]}` : `MISS ${path} (${pt.length} bytes)`);
}
console.log('super_encrypted_hash:', (() => { const pt = decryptV10(key, Buffer.from(secure.protection.super_encrypted_hash, 'base64'));
  const macs = secure.protection.macs; return Object.entries(cands('', macs)).find(([, d]) => d.equals(pt))?.[0] ?? 'MISS'; })());
