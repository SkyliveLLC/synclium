// Tries to reproduce Chromium tracked-pref MACs (services/preferences/tracked/pref_hash_calculator.cc):
//   mac = HMAC-SHA256(key = seed, msg = device_id + path + json(value)) as uppercase hex.
// Usage: node mac.mjs <profileDir>   (reads Default/Secure Preferences + Default/Preferences)
// Prints which (seed, device_id) candidate reproduces each MAC. The machine UUID is never printed.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac, createHash } from 'node:crypto';

const hmacHex = (key, msg) => createHmac('sha256', key).update(msg).digest('hex');
const deviceIdsFor = (uuid) => ({
  empty: '',
  uuid,
  uuidLower: uuid.toLowerCase(),
  // GenerateDeviceIdLikePrefMetricsServiceDid: lowercase hex HMAC-SHA256(key = machine id, "PrefMetricsService")
  pmsDid: hmacHex(uuid, 'PrefMetricsService'),
  sha256: createHash('sha256').update(uuid).digest('hex'),
});


// Chromium JSON-serializes the value (base::JSONWriter) after stripping empty dicts/lists inside
// dictionaries (RemoveEmptyValueDictEntries); a missing value hashes as the empty string. JSONWriter
// emits dict keys in bytewise order and escapes '<', U+2028 and U+2029. JSON.stringify cannot be used
// directly: JS objects always enumerate integer-like keys ("16" before "128") first.
const isEmpty = (v) => v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
const str = (x) => JSON.stringify(x).replace(/</g, '\\u003C').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const bytewise = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const write = (v, strip) => {
  if (Array.isArray(v)) return `[${v.map((x) => write(x, strip)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort(bytewise).filter((k) => !(strip && isEmpty(v[k])));
    return `{${keys.map((k) => `${str(k)}:${write(v[k], strip)}`).join(',')}}`;
  }
  return str(v);
};
export const ser = (v) => (v === undefined ? '' : write(v, true));

export const mac = (seed, deviceId, path, value) => createHmac('sha256', seed).update(deviceId + path + ser(value)).digest('hex').toUpperCase();

if (import.meta.url === `file://${process.argv[1]}`) {
const dir = process.argv[2] ?? "";
const secure = JSON.parse(readFileSync(`${dir}/Default/Secure Preferences`, 'utf8'));
const plain = JSON.parse(readFileSync(`${dir}/Default/Preferences`, 'utf8'));
const uuid = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }).match(/"IOPlatformUUID" = "([^"]+)"/)[1];

const get = (root, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), root);
const lookup = (path) => { const a = get(secure, path); return a !== undefined ? a : get(plain, path); };


// Flatten protection.macs into [path, mac]; split prefs (extensions.settings) nest one level deeper.
const flat = [];
const walk = (o, p) => { for (const [k, v] of Object.entries(o)) { if (k.endsWith('_encrypted_hash')) continue; const path = p ? `${p}.${k}` : k; typeof v === 'string' ? flat.push([path, v]) : walk(v, path); } };
walk(secure.protection.macs, '');

const deviceIds = deviceIdsFor(uuid);
const seeds = { empty: '' };
let hits = 0;
for (const [path, want] of flat) {
  let found = null;
  for (const [sn, seed] of Object.entries(seeds)) for (const [dn, did] of Object.entries(deviceIds)) {
    if (mac(seed, did, path, lookup(path)) === want) found = `seed=${sn} device=${dn}`;
  }
  if (found) hits++;
  console.log(found ? 'OK  ' : 'MISS', path, found ?? '');
}
// super_mac: HMAC over device_id + "" + json(protection.macs) (the whole macs dict, *_encrypted_hash entries included)
for (const [dn, did] of Object.entries(deviceIds)) {
  if (mac('', did, '', secure.protection.macs) === secure.protection.super_mac) console.log('super_mac OK device=' + dn);
}
console.log(`${hits}/${flat.length} reproduced`);
}
