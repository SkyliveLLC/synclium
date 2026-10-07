# P9: full profile mode grounding (settings, search engines, autofill)

Helium 0.18.3.1 (Chromium 154.0.8037.97), scratch copy `/tmp/helium-sync-scratch/HeliumScratch.app`
(bundle id `net.imput.helium.scratch`), `--user-data-dir=/tmp/helium-sync-scratch/p9-profile/profile`,
`--use-mock-keychain`. The real profile, the real app, and the real keychain were not touched.
Unless marked **inferred**, everything below was observed.

## Run log and incidents
- Port: the brief said 9351, but another agent's scratch browser (`/tmp/hs-dav/profile-A`, PID 47738) was
  launched on 9351 at the same time and bound `[::1]:9351`. Mine bound `127.0.0.1:9351`, and Node's
  `localhost` can resolve to either. I checked that no pref writes leaked into their profile. p9 then
  moved to **:9361**, and `cdp.mjs` refuses to talk to any browser whose GUID differs from the last
  "DevTools listening" line in our own log.
- Two Helium CHECK crashes were mine. Both came from malformed WebUI messages:
  `setDefaultValueForContentType` (SIGTRAP), and a search-engine handler called with a missing or null
  argument (`bad_variant_access`). Pass every argument, typed. In those crashes, prefs that were not yet
  flushed (about a 10 s commit window) were lost.
- CDP `Browser.close` leaves `profile.exit_type = "Crashed"` in Preferences (seen in snap2).
- Snapshots: `snap0-fresh` (first run), `snap1-settings`, `snap2-data` (settings, search engines, address,
  card). Each tamper case is in `case-<name>/`.

## Q1 Preferences vs Secure Preferences
Diff snap0 -> snap2, after changes made through `chrome.settingsPrivate.setPref` and the search-engine
browser proxy on chrome://settings:
- **Secure Preferences**: `homepage`, `homepage_is_newtabpage`, `browser.show_home_button`,
  `session.restore_on_startup`, `session.startup_urls`, `default_search_provider_data.template_url_data`
  (DSE as a full TemplateURLData dict), `schedule_to_flush_to_disk`. Also present: `extensions.settings.*`
  and `pinned_tabs`.
- **Preferences** (unprotected): `download.prompt_for_download`, `helium.browser.show_back_button`,
  `webkit.webprefs.default_font_size` (and an auto-added `default_fixed_font_size`), `intl.accept_languages`,
  `profile.default_content_setting_values.cookies` (4 = session only), `autofill.profile_enabled`,
  `autofill.credit_card_enabled`, `default_search_provider.guid` and `choice_screen_*`, and
  **`default_search_provider_data.mirrored_template_url_data`**, an unprotected mirror of the DSE.
- Preferences has no `protection` key, so every tracked pref is in Secure Preferences.
- Tracked paths in `protection.macs` (each one has a sibling `<path>_encrypted_hash`, and for split prefs
  `<path>_encrypted_hash.<key>`):
  `account_values.{browser.show_home_button, extensions.ui.developer_mode, homepage, homepage_is_newtabpage,
  session.restore_on_startup, session.startup_urls}`, `browser.show_home_button`,
  `default_search_provider_data.template_url_data`, `enterprise_signin.policy_recovery_token`,
  `extensions.install.initiallist`, `extensions.install.initialprovidername`, `extensions.settings.<id>` (split),
  `extensions.ui.developer_mode`, `homepage`, `homepage_is_newtabpage`, `media.storage_id_salt`, `pinned_tabs`,
  `prefs.preference_reset_time`, `schedule_to_flush_to_disk`, `search_provider_overrides`,
  `session.restore_on_startup`, `session.startup_urls`; plus `super_mac` and `super_encrypted_hash`.
  `account_values` has MACs but no values, because there is no sync.
- Helium defaults: autofill addresses and cards are **off** (`autofill.profile_enabled` and
  `credit_card_enabled` false), and `chrome://settings/payments` redirected to the settings root while
  they were off.

## Q2 MAC scheme (reproduced 24/24, plus super_mac)
`mac.mjs`:
- `MAC = upper(hex(HMAC-SHA256(key = "", msg = device_id + path + json(value))))`.
- The seed is **empty**.
- `device_id` = the **raw IOPlatformUUID string** as `ioreg -rd1 -c IOPlatformExpertDevice` prints it
  (uppercase, with dashes; not hashed).
- The path includes prefixes (`account_values.homepage`). For split prefs it is
  `extensions.settings.<id>`. An absent value hashes as `""`.
- `json` = Chromium JSONWriter: keys in bytewise order, `<` escaped as `<` (also U+2028/2029),
  empty dicts and lists inside dicts removed. **JS gotcha:** `JSON.stringify` puts integer-like keys
  first ("16" before "128"), which broke uBlock's MAC until I wrote a custom serializer. Doubles were not
  exercised.
- `super_mac` = the same HMAC with an empty path over the whole `protection.macs` dict, `_encrypted_hash`
  entries included.
- **New in this build:** `<path>_encrypted_hash` = base64(`"v10"` + AES-128-CBC(SHA-256(path + json(value))))
  under the OSCrypt key, so it is keychain-bound. Reproduced 24/24 with the mock key (`enchash.mjs`).
  `super_encrypted_hash` was not reproduced; I tried SHA-256 and HMAC over the macs dict with all
  entries, without encrypted hashes, and with only them.

## Q3 Tamper (browser closed, then relaunch; `runcase.sh <case>` from snap2)
| case | result |
|---|---|
| plain: Preferences `download.prompt_for_download`, font size | **survive** |
| nomac: homepage edited, MACs stale | **reset** to default; banner on chrome://settings: "Helium reset these settings. These settings were changed from outside of Helium. To protect you, Helium reset them. Homepage [Learn more] [Got it]"; Preferences `prefs.tracked_preferences_reset: ["homepage"]`; `prefs.preference_reset_time` written |
| mac: correct MAC + super_mac, stale encrypted hash | **reset** (same banner) |
| enc: correct encrypted hash, stale MAC + super_mac | **reset** |
| mac+enc: both correct, super_encrypted_hash stale | **survives**, no banner |
| dsp: DSE fields edited, re-signed, `synced_guid` not matching the guid pref, mirror not updated | no tracked reset, but the DSE was dropped: Preferences `default_search_provider.reset_occurred: true`, the DSE fell back to the prepopulated one, and the mirror was cleared |
| dsp2: re-signed DSE pointing at existing keywords row 16, guid pref updated, mirror stale | same reset_occurred drop |
| dsp3: dsp2 + `mirrored_template_url_data` = same dict | **survives**; settings shows "P9 Test Engine" as the default |
| dsp0: control, unchanged re-sign | unchanged |

Binary strings near this: `default_search_provider_data.mirrored_template_url_data`,
`Search.DefaultSearchEngineMirrorCheckOutcome`, `default_search_provider.reset_occurred`.

## Q4 Web Data (`Web Data`, meta version 154, journal_mode=delete)
- `keywords(id PK, short_name, keyword, favicon_url, url, safe_for_autoreplace, originating_url, date_created,
  usage_count, input_encodings, suggest_url, prepopulate_id, created_by_policy, last_modified, sync_guid,
  alternate_urls, image_url, search_url_post_params, suggest_url_post_params, image_url_post_params, new_tab_url,
  last_visited, created_from_play_api, is_active, starter_pack_id, enforced_by_policy, featured_by_policy, url_hash BLOB)`.
  - Times are Chromium µs since 1601.
  - URLs use `{searchTerms}`.
  - Custom engine: `prepopulate_id=0`, `safe_for_autoreplace=0`, `is_active=1`, `alternate_urls='[]'`,
    a random UUID `sync_guid`.
  - `url_hash` = `"v10"` + AES(`0x02` + 32-byte digest). I could not identify the digest input: brute
    force over up to 4 ordered field strings (5 separators), binary id/Pickle encodings, and URL variants
    all missed. Binary string: `Search.KeywordTable.HashValidationStatus`.
- DSE linkage: Secure Preferences `default_search_provider_data.template_url_data` (with `id` = keywords.id
  as a string and `synced_guid` = sync_guid), plus the Preferences mirror and `default_search_provider.guid`.
- `autocomplete(name, label, label_normalized, value, value_lower, date_created, date_last_used, count,
  PK(name,label,value))`. Times are unix seconds.
- `addresses(guid PK, use_count, use_date, date_modified, language_code, label, initial_creator_id, record_type)`
  + `address_type_tokens(guid, type, value, verification_status, observations, PK(guid,type))`.
  - One address = 38 token rows: 3 first, 5 last, 7 full name, 9 email, 14 phone, 33 city, 34 state,
    35 zip, 36 country, 77 street, 109 last-name part, and others empty.
  - Times are unix seconds. `record_type=0` (local). `initial_creator_id=70073`.
- `credit_cards(guid PK, name_on_card, expiration_month, expiration_year, card_number_encrypted, date_modified,
  use_count, use_date, billing_address_id, nickname, is_user_confirmed)`.
  - Observed blob: `v10` + 32 bytes. It decrypts (`oscrypt.mjs`) with
    PBKDF2-SHA1(`mock_password`, `saltysalt`, 1003, 16), AES-128-CBC, IV = 16 spaces, to
    `4111111111111111`.
  - Also present: `local_stored_cvc(value_encrypted)` (empty).
- Keychain name: these binary strings sit together: `v10`, `use-mock-keychain`, `saltysalt`,
  `Helium Storage Key`, `Helium`, `mock_password`. **Inferred:** keychain service
  "**Helium Storage Key**", account "Helium" (Chromium uses "Chromium Safe Storage"/"Chromium").
  Not read from the keychain.
- Form autocomplete capture: submitting a local GET form with CDP-typed values (`insertText`, then
  per-character key events) recorded **no** autocomplete rows. Autofill upload events were counted, so the
  form was seen. Cause unknown.

## Q5 Offline writes to Web Data (`webdata-write.mjs`, browser closed, then relaunch; `case-webdata/`)
- Keyword with `url_hash` NULL and keyword with a wrong (copied) `url_hash`: **both listed** in
  chrome://settings search engines. After a run, the hashes were **not rewritten** (still NULL and still
  wrong), so this build does not enforce them.
- An address with 38 token rows was **listed**. A card encrypted with the mock key was **listed** and
  decrypted in the browser (Mastercard ••4444).
- Autocomplete rows persisted across a run. Whether they appear in the dropdown was not verified.
- Sync metadata: `autofill_sync_metadata` and `autofill_model_type_state` are empty (no sync in Helium).
  Nothing else needs maintaining. Keyword `sync_guid` must be a unique UUID.

## Q6 Device-specific, never sync
- `browser.window_placement.*` (including work_area), `profile.content_settings.exceptions.window_placement`.
- `download.default_directory`, `savefile.default_directory`, `selectfile.last_directory`, file-system
  last-picked dirs.
- `extensions.settings.<id>.path` (absolute bundle paths), all of `protection.*`, `media.device_id_salt`,
  `media.storage_id_salt`.
- `profile.exit_type`, `sessions.*`, `in_product_help.*`, `*_last_*`/`*timestamp*` metrics,
  `optimization_guide.*`, `segmentation_platform.*`, `domain_diversity.*`, `autofill.upload_*`.
- `enterprise_profile_guid`, `countryid_at_install`, `apps.shortcuts_os_version`,
  `default_search_provider.choice_screen_*`.
- All of Local State (`profile.info_cache`, `hardware_acceleration_mode_previous`, stability, uninstall
  metrics).
- Keychain-encrypted blobs (card numbers, `*_encrypted_hash`, `url_hash`): **inferred** to need
  re-encryption per machine, because every Mac has its own Safe Storage key.

## Scripts
`launch.sh`, `wait-closed.sh`, `cdp.mjs` (identity-guarded), `webui.js`, `form.mjs`, `oscrypt.mjs`, `mac.mjs`,
`enchash.mjs`, `tamper.mjs`, `runcase.sh`, `webdata-write.mjs`.
