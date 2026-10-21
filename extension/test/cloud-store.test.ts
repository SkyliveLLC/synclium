// Synclium Cloud from the extension's side: the vault token the sync key derives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cipherFor, mintSyncKey, parseSyncKey, vaultTokenFor, type SyncKey } from '../src/sync-key.ts';

function syncKey(text: string): SyncKey {
  const key = parseSyncKey(text);
  assert.ok(key !== null, text);
  return key;
}

const FIXED_KEY = syncKey('0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJ0');

test('the vault token is pinned: changing its derivation would orphan every vault', async () => {
  assert.equal(await vaultTokenFor(FIXED_KEY), 'f53gI-xhod936ODZF2_sMRSuL_pQWBWkbmKmw3RsPJY');
});

test('the vault token follows the key and shares nothing with the key id or the key', async () => {
  const other = mintSyncKey();
  const token = await vaultTokenFor(FIXED_KEY);
  assert.equal(await vaultTokenFor(FIXED_KEY), token, 'every device with the key finds the same vault');
  assert.notEqual(await vaultTokenFor(other), token, 'another key, another vault');
  const keyId = (await cipherFor(FIXED_KEY)).keyId;
  assert.ok(!Buffer.from(token, 'base64url').toString('hex').includes(keyId), 'the token does not carry the key id');
  assert.ok(!token.includes(FIXED_KEY.slice(0, 8)), 'the token does not carry the key');
});
