// Applies one tamper case to the CLOSED scratch profile's pref files.
// node tamper.mjs <case>   cases:
//   plain      edit unprotected prefs in Preferences (download prompt, font size)
//   nomac      edit protected homepage in Secure Preferences, MACs untouched
//   mac        same edit + recomputed homepage MAC and super_mac (encrypted hashes left stale)
//   mac+enc    same as mac + recomputed homepage_encrypted_hash (mock keychain key); super_encrypted_hash stale
//   enc        same edit + recomputed homepage_encrypted_hash only (MAC and super_mac stale)
//   dsp3       dsp2 + the unprotected mirror Preferences default_search_provider_data.mirrored_template_url_data
//   dsp0       control: re-sign the unchanged default_search_provider_data
//   dsp2       point the default at existing custom keywords row 16 (fields copied), re-signed, plus
//              Preferences default_search_provider.guid set to the same sync_guid
//   dsp        default_search_provider_data edit with recomputed MAC + super_mac + encrypted hash
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, createCipheriv } from 'node:crypto';
import { mac, ser } from './mac.mjs';
import { keyFor } from './oscrypt.mjs';
const dir = '/tmp/helium-sync-scratch/p9-profile/profile/Default';
const uuid = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }).match(/"IOPlatformUUID" = "([^"]+)"/)[1];
const read = (f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
const write = (f, o) => writeFileSync(`${dir}/${f}`, JSON.stringify(o));
const encV10 = (buf) => { const c = createCipheriv('aes-128-cbc', keyFor('mock_password'), Buffer.alloc(16, ' ')); return Buffer.concat([Buffer.from('v10'), c.update(buf), c.final()]).toString('base64'); };
// Re-signs one top-level atomic pref: MAC, optional encrypted hash, then super_mac over the whole macs dict.
const resign = (sp, path, value, { enc, macs = true }) => {
  if (macs) sp.protection.macs[path] = mac('', uuid, path, value);
  if (enc) sp.protection.macs[`${path}_encrypted_hash`] = encV10(createHash('sha256').update(path + ser(value)).digest());
  if (macs) sp.protection.super_mac = mac('', uuid, '', sp.protection.macs);
};
// default_search_provider_data.template_url_data is stored nested, so its MACs nest too.
const resignNested = (sp, t) => {
  const path = 'default_search_provider_data.template_url_data';
  sp.protection.macs.default_search_provider_data.template_url_data = mac('', uuid, path, t);
  sp.protection.macs.default_search_provider_data.template_url_data_encrypted_hash = encV10(createHash('sha256').update(path + ser(t)).digest());
  sp.protection.super_mac = mac('', uuid, '', sp.protection.macs);
};
const c = process.argv[2];
if (c === 'plain') {
  const p = read('Preferences');
  p.download.prompt_for_download = false;
  p.webkit.webprefs.default_font_size = 20;
  write('Preferences', p);
} else if (['nomac', 'mac', 'mac+enc', 'enc'].includes(c)) {
  const sp = read('Secure Preferences');
  sp.homepage = 'https://tampered.example/' + c;
  if (c !== 'nomac') resign(sp, 'homepage', sp.homepage, { enc: c !== 'mac', macs: c !== 'enc' });
  write('Secure Preferences', sp);
} else if (c === 'dsp') {
  const sp = read('Secure Preferences');
  const t = sp.default_search_provider_data.template_url_data;
  Object.assign(t, { short_name: 'P9 Offline DSP', keyword: 'p9dsp', url: 'https://p9dsp.example.test/s?q={searchTerms}', prepopulate_id: 0, safe_for_autoreplace: false, synced_guid: '9f0e7c1a-0000-4000-8000-0000000000d5', id: '0' });
  resignNested(sp, t);
  write('Secure Preferences', sp);
} else if (c === 'dsp0') {
  const sp = read('Secure Preferences');
  resignNested(sp, sp.default_search_provider_data.template_url_data);
  write('Secure Preferences', sp);
} else if (c === 'dsp2' || c === 'dsp3') {
  const sp = read('Secure Preferences');
  const t = sp.default_search_provider_data.template_url_data;
  const guid = '68872e2d-39e2-41ef-be26-305484d08cdc';
  Object.assign(t, { id: '16', short_name: 'P9 Test Engine', keyword: 'p9', url: 'https://p9.example.test/search?q={searchTerms}', prepopulate_id: 0, safe_for_autoreplace: false, synced_guid: guid,
    suggestions_url: '', image_url: '', image_url_post_params: '', new_tab_url: '', favicon_url: '', is_active: 1 });
  resignNested(sp, t);
  write('Secure Preferences', sp);
  const p = read('Preferences');
  p.default_search_provider.guid = guid;
  if (c === 'dsp3') p.default_search_provider_data.mirrored_template_url_data = t;
  write('Preferences', p);
} else throw new Error('unknown case ' + c);
console.log('applied', c);
