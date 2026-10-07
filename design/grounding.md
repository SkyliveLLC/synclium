# Grounding: Helium profile sync (all observed on Helium 154 / macOS unless marked)

## Target system
- Helium = Chromium 154 fork. No Google sync. User data dir: macOS `~/Library/Application Support/net.imput.helium/`, profile `Default/`. Linux/Windows paths: unverified (expected `~/.config/net.imput.helium`, `%LOCALAPPDATA%\imput\Helium\User Data`).
- Profile README says: "Helium settings and storage ... MUST not be extracted, overwritten or modified except through Helium defined APIs."
- Runtime available: Node 24 (node:sqlite, TS type stripping). No bun/go/rust installed.

## P1: direct file adapter (scripts: /tmp/helium-sync-scratch/p1-file/)
- Bookmarks JSON: roots bookmark_bar/other/synced; nodes have stable `guid`, local `id`, `date_added` (Chromium µs since 1601), name, url, children.
- Checksum reproduced exactly (MD5 preorder: id utf8, name utf16le, "url"+url | "folder"+children). Bad checksum is tolerated anyway.
- Offline write (browser closed): guid and date_added preserved. Chromium writes Bookmarks.bak.
- Write while running: ignored by the browser and clobbered by next in-browser change. => file adapter may only write when browser is closed.
- Running detection: SingletonLock symlink -> `<host>-<pid>` survives SIGTERM/SIGKILL. Reliable check = host matches + pid alive + pid is the Helium binary.
- History SQLite: normal read-only open => SQLITE_BUSY (Chromium holds lock). `?immutable=1` or copy works. journal_mode=delete. Commits batch ~10s. Need readBigInts. Visit times preserved only through file adapter.

## P2: companion extension + native messaging (scripts: /tmp/helium-sync-scratch/p2-ext/)
- MV3 extension works; `--load-extension` works in Helium (dev only; not persistent across restarts).
- Native host manifest discovered at `<user-data-dir>/NativeMessagingHosts/<name>.json`.
- Topology proven: extension --connectNative--> host (spawned by Helium) --unix socket--> external CLI. CLI cannot reach the browser when Helium isn't running.
- Native port keeps the MV3 worker alive (>= 9 min observed).
- chrome.bookmarks: ids local and browser-assigned; NO guid exposed. Sync needs its own syncGuid<->localId map (e.g. chrome.storage.local).
- history.addUrl cannot set visitTime (imported history loses timestamps). management.getAll lists extensions (read-only, no install). sessions.getDevices empty. No password API.
- Install friction: real user must enable Developer mode + Load unpacked (persistence through the button unobserved), or we ship via a store/CRX.

## P3: merge model + store layout (scripts: /tmp/helium-sync-scratch/p3-merge/)
- Store = dumb folder (iCloud/Dropbox/Syncthing) first; later S3/WebDAV/server.
- Shared single file + 3-way merge: lost writes / ping-pong non-convergence in 4 of 9 scenarios; 20/36 runs caused folder conflicts.
- Per-device files `devices/<deviceId>.json` (each device writes only its own, full merged state), per-node registers {title, url, location(parent+position), deleted} each stamped with HLC `wall.counter.deviceId`: converged in all scenarios, 0 folder conflicts, idempotent after crash.
- Rules: delete beats concurrent edit; orphan re-homed to nearest live ancestor; fractional string positions within folder; first-join adoption by (parent, kind, title, url) is REQUIRED or bookmarks duplicate; tombstone GC when all live devices have newer stamps; evict devices idle > N days. Clock skew can flip LWW (accepted).
- Size: 500 real nodes = ~31KB gzip per device file; 50k nodes = ~2MB gzip, 155ms merge for 3 devices.

## Data-type coverage matrix
| data | file adapter (browser closed) | extension adapter (browser running) |
|---|---|---|
| bookmarks | full, guid native | full, needs guid map |
| history | full fidelity | read yes, write loses timestamps |
| open tabs | Sessions files (unexplored, binary SNSS) | chrome.tabs read/write, live |
| extensions list | read Preferences; install blocked (Secure Preferences MAC) | read only |
| passwords | possible via keychain decrypt/re-encrypt (unverified) | impossible |

## Round 2 (2026-10-06): direction change and new facts

### Decisions by Conan
- Product is the EXTENSION. The CLI is no longer the first frontend.
- Writing Helium profile files directly is OPT-IN only. Default respects the README ("only through Helium defined APIs").
- No encryption at rest in v1 (keep the codec seam).
- History is the second data type.

### P5: history volume (real profile, read-only copy, counts only)
- 90 days retained (Chromium expiry). 45,970 visits, 16,971 distinct urls.
- Full-state per-visit file: 19 MB raw, 1.9 MB gzip per device. Per-url (title + last visit): 3.7 MB raw, 1.1 MB gzip.
- 30-day slice: 11k visits, 451 KB gzip. => history must be sharded (e.g. per day); full-state-per-device rewrite is wasteful.
- Extension API cannot set visit time (P2). Writing remote visits via history.addUrl stamps them "now" (pollutes today's history).

### P6: Chrome Web Store in Helium (CDP, scratch profile)
- Helium supports CWS out of the box: "Add to Helium" button (Helium component extension rewrites labels), chrome.webstorePrivate present, getExtensionStatus "installable", trusted click starts install (native confirm dialog not observed: screen locked).
- Extension downloads/updates are proxied through services.helium.imput.net (helium.services.ext_proxy=true). Users can self-host Helium services.
- Self-hosted CRX: blocked for normal users unless flag #extension-mime-request-handling or policy (inferred).
- => Distribution = publish on CWS. Developer-mode unpacked is a dev path only.

### Still unverified (needs an unlocked screen + computer use)
- File System Access API from an extension page: can the user pick an iCloud/Dropbox folder once, and does the handle stay writable (from the service worker too) after a browser restart without re-prompting?
- Load-unpacked persistence across restarts (dev path only now).
- CWS confirm dialog text and resulting installType.

## P7 round 1 (2026-10-06, computer use on a separately-identified "Helium Scratch" app copy)
- Picker accepts an iCloud Drive subfolder. Prompt: "Allow this site to edit files? <ext> will be able to edit files in <folder>" [Don't Allow] [Allow].
- With the grant, the service worker reads the handle from IndexedDB and can getFileHandle, createWritable/close, and list. `.txt`, `.json.gz`, `.hsync` all write.
- Same-size rewrite changes File.lastModified (2 s apart).
- After restart: queryPermission=prompt, all calls NotAllowedError, page and worker. Caveat: extension was loaded with --load-extension (reinstalled each launch). Round 2 re-probes with a normal Load-unpacked install and a requestPermission button.
- Load unpacked through the UI persists across restarts, Developer mode stays on, no warning bubble.
- CWS confirm dialog: "Add "JSON Formatter"? It can: Read and change all your data on all websites" [Cancel] [Add extension]. Download then failed "Extension downloads are disabled" in a fresh scratch profile (inferred: Helium services setup not completed).

## P7 round 2 (normal Load-unpacked install, requestPermission button)
- Initial picker grant lapses after the first restart (queryPermission=prompt).
- requestPermission from a click shows: "<ext> wants to / View and edit files from the last time you visited this site: <folder>" [Allow this time] [Allow on every visit] [Don't allow].
- After "Allow on every visit", the worker stayed granted and wrote across two more restarts. => Rung B: one click, once, after the first restart.

## P8: readingList + management APIs (2026-10-06, scratch Helium 0.18.3.1 / Chromium 154; prototypes/p8-apis/)
- chrome.readingList present: query/addEntry/updateEntry/removeEntry + onEntryAdded/Updated/Removed (fire for API calls too). Entry: {url, title, hasBeenRead, creationTime, lastUpdateTime}; timestamps cannot be set.
- http(s) only ("URL is not supported." otherwise). Urls are normalized on store (https://Example.COM -> https://example.com/); #fragment and ?query make distinct entries.
- Errors: "Duplicate URL.", "URL not found.", update with neither title nor hasBeenRead refused. Title-only updates do not bump lastUpdateTime. One update of both fields fires two onEntryUpdated.
- Persists across restart (Sync Data/LevelDB). Adding an entry creates no bookmark. UI: chrome://read-later.top-chrome/ ("Reading List").
- chrome.management: getAll/get/getSelf/setEnabled/uninstall/... and onInstalled/onUninstalled/onEnabled/onDisabled. No install method. --load-extension -> installType "development"; Helium's bundled uBlock Origin -> installType "other". No updateUrl key on either.

## P9: profile files for the opt-in full profile mode (2026-10-06, scratch, mock keychain; prototypes/p9-profile/notes.md)
- Secure Preferences protects: homepage, homepage_is_newtabpage, show_home_button, restore_on_startup, startup_urls, default_search_provider_data, pinned_tabs, extensions.settings, developer mode. Unprotected (Preferences): download prompt, fonts, languages, content-setting defaults, Helium UI toggles, autofill enable flags.
- MAC = HMAC-SHA256(key "", hardware UUID as ioreg prints it + path + Chromium-sorted JSON value). Reproduced 24/24, plus super_mac. New in this build: a per-pref encrypted_hash (SHA-256 of path+value encrypted with the Safe Storage key); a protected edit survives only with both correct (super_encrypted_hash may stay stale).
- Closed-browser edits: unprotected pref survives; protected pref with a stale MAC is reset with a "Helium reset these settings" banner; default search engine needs the protected value, both hashes, the unprotected mirror, and the guid pref to agree, else it silently reverts.
- Web Data: keywords (sync_guid, prepopulate_id=0 for custom, new encrypted url_hash; NULL/wrong is tolerated today), autocomplete, addresses + address_type_tokens, credit_cards (v10 AES-128-CBC, PBKDF2 saltysalt/1003; real key inferred from keychain item "Helium Storage Key"). Rows added while closed show up after launch. Sync metadata tables are empty.
- Address and card autofill ship disabled in Helium.
- Never sync: window placement, download/save dirs, extension install paths, `protection`, media salts, exit type, session data, metrics, choice-screen state, all of Local State, anything keychain-encrypted.
