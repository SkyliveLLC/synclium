// Decrypts Chromium macOS OSCrypt "v10" blobs: AES-128-CBC, key = PBKDF2-SHA1(password, "saltysalt", 1003, 16),
// IV = 16 spaces. The password comes from the "<Browser> Safe Storage" keychain item, or "mock_password"
// under --use-mock-keychain. Usage: node oscrypt.mjs <password> <hex-or-base64-blob>...
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
export const keyFor = (password) => pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
export function decryptV10(key, blob) {
  if (blob.subarray(0, 3).toString() !== 'v10') throw new Error('not v10: ' + blob.subarray(0, 3));
  const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([d.update(blob.subarray(3)), d.final()]);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const key = keyFor(process.argv[2]);
  for (const s of process.argv.slice(3)) {
    const blob = /^[0-9A-F]+$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
    try { const out = decryptV10(key, blob); console.log(JSON.stringify(out.toString('latin1')), out.toString('hex')); } catch (e) { console.log('FAIL', e.message); }
  }
}
