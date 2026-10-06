# helium-sync as an MV3 extension over a network store

Candidate 2, round 2. Direction: the extension talks to storage over HTTP with `fetch` from the service worker. No local files in the default mode.

## Problem

Helium has no Google sync. Round 2 fixed the product as a Chrome Web Store extension, with direct profile-file writes opt-in only, no encryption at rest, and history as the second data type. Round 1 proved the merge model on a dumb folder: per-device files, per-field LWW registers with HLC stamps, the fold rule, adoption by content, and a `Store` whose only contract is one writer per key.

The extension runtime changes four things the round-1 shape leaned on. The browser is always running when our code runs, so the offline/live/read-only session union is dead weight. `chrome.bookmarks` has no guid, so `ItemId` cannot be the Chromium guid. The service worker dies after 30 s idle and has no `node:*`, no filesystem, no DOMParser, and no process to hold a lock. And a network store charges a round trip per read where a folder read was free, which matters once history adds ~90 files per device. History itself is a different kind of data: visits are facts an author owns, not registers anyone edits, and `history.addUrl` cannot set a visit time (P2, P5).

Everything else from round 1 stays: `crdt.ts` and `types/bookmarks.ts` are copied unchanged except a `model` tag; the register cycle in `engine.ts` is the round-1 cycle line for line.

## Usage (caller's view)

### What the user does

Device 1: install from the Chrome Web Store. The options page opens. Pick a provider (Nextcloud, ownCloud, Synology, Fastmail, Hetzner Storage Box, Koofr, pCloud, other WebDAV), type the server, username, and an app password (the form links to where that provider issues one), click **Connect**. Chrome asks once: "helium-sync wants to read and change your data on cloud.example.com". Allow. Name the device. Done; under a minute if the app password is at hand. The first cycle publishes your bookmarks and starts collecting history.

Device 2: install. On device 1, popup → **Pair another device** → **Copy**. Move the string however you move secrets between your machines (password manager note, note-to-self). On device 2, paste it, click **Join**, allow the same prompt, name the device. Twenty seconds. The first cycle adopts matching bookmarks by content, merges, and applies the rest through `chrome.bookmarks`.

Steady state: nothing. The popup shows "Bookmarks: in sync, 512 items, 2 min ago", "History: 3 devices, pulled 4 min ago", and each peer's last-seen time. Remote history appears in the extension's **Synced history** page with real timestamps and the device that made each visit. Two opt-ins live under Settings: address-bar hints (one untitled `addUrl` per remote URL), and the companion that writes synced visits into Helium's history database when Helium quits.

### The service worker wires the engine

```ts
const db = await openDatabase();
const ids = idbIdMap(db);
const engine = createEngine({
  registry,
  store: storeFor(config),                    // webdav today; the union grows, every switch fails until handled
  codec: gzipJson, clock: Date, platform, appVersion,
  local: idbLocalState(db, registry, { name: settings.deviceName }),
  profile: {
    registers: () => chromeBookmarksChannel(ids),
    log: () => chromeHistoryChannel({
      view: viewSink(),
      hints: settings.omniboxHints ? omniboxHintSink(markEcho) : null,
      native: settings.nativeHost ? nativeHost() : null,
    }),
  },
});
chrome.alarms.onAlarm.addListener(() => runSync({}));   // runSync holds navigator.locks('helium-sync:engine')
```

### The options page connects

```ts
const granted = await requestHostPermission(config.url);   // inside the click handler
if (granted === 'denied') return show('Helium needs permission to reach your server.');
const reply = await chrome.runtime.sendMessage({ kind: 'connect', config } satisfies Message);
```

### The popup renders

```ts
const { report, settings } = await chrome.storage.local.get(['report', 'settings']);
for (const line of describe(report, settings)) render(line);   // every Blocked and StoreFailure has one sentence and one action
```

### Adding a data type

```ts
export const openTabs: LogType<TabEvent> = { model: 'log', version: 1, retentionDays: 7, parseEvent, key, label };
export const registry = { bookmarks, history, openTabs } as const satisfies Registry;
```

`Profile.log` and `LocalState.log` are keyed by `LogTypes<Reg>`, so the profile fails to compile until it returns an `openTabs` channel. A probe confirmed `profile.registers('history')` and `profile.log('bookmarks')` are compile errors.

## Shape

### Two models, one registry

`DataType = RegisterType<R> | LogType<E>`. Bookmarks are registers (round 1). History is a log: an event is a fact one device observed at time `t`; nobody edits it, two devices never produce the same one, so it needs no stamp, no tombstone, and merge is set union. A device publishes only its own events, one file per UTC day. P5 priced the alternative (full per-visit state per device, rewritten every cycle) at 1.9 MB gzip; a day shard is about 15 KB and only today's changes. The engine switches on `model` once per type, exhaustively. This is the `mode: 'publish'` variant round 1 reserved for open tabs, arriving one type early (per model-the-domain).

### Store layout: the manifest is the commit point

```
devices/<deviceId>/manifest.json                  presence + index of this device's files {rel: {hash, bytes}}, seq
devices/<deviceId>/bookmarks.json.gz              round-1 StateFile, same envelope and bytes
devices/<deviceId>/history/<YYYY-MM-DD>.json.gz   ShardFile: this author's visits of that day
```

Round 1's `meta.json` grew an index and became `manifest.json`. A device publishes files first and its manifest last. A reader does one conditional GET per peer per cycle (`If-None-Match`, 304 is ~200 bytes), and downloads only the files whose hash changed. It verifies every download against the manifest hash before parsing, so a torn or half-finished PUT, or a crash between file and manifest, reads as "not yet" and the peer's last good copy stands. Nothing is shared; every key has one writer (per separate-before-serializing-shared-state). Steady state with three devices and a 5-minute poll is three 304s per cycle. `list('devices/')` runs every 15 minutes or on **Sync now** to discover new peers; it is the only PROPFIND in the steady state.

### Backends: WebDAV in v1, no hosted default

WebDAV is the self-hostable tiny server. Nextcloud, ownCloud, Synology, Fastmail, Hetzner, Koofr, pCloud, Apache, nginx, Caddy, `rclone serve webdav`, and `dufs` all speak it, and our needs (GET with ETag, PUT, DELETE, PROPFIND for discovery) are its core. Writing a bespoke `helium-sync-server` would add a deploy surface, a release channel, and an auth scheme to gain nothing WebDAV lacks; a WebSocket push is moot because MV3 should not hold a socket open to save a 304. Users with no server at all have a free zero-infrastructure path (Koofr's free tier speaks WebDAV).

S3-compatible storage (R2, B2, MinIO, Garage) is the second backend, one file (`adapters/s3-store.ts`, SigV4 over WebCrypto) and one member of the `StoreConfig` union, no engine change. It is not in v1 because WebDAV already covers the Helium user who runs a NAS or a Nextcloud, and SigV4 plus ListObjects XML is real code.

A hosted default is rejected for v1 on three grounds. Round 2 ships no encryption at rest, so a hosted store would hold users' plaintext bookmarks and browsing history under our key, which the "only through Helium APIs" README spirit and the de-Googled audience both argue against. Accounts, quotas, and abuse are product work, not design. And Helium's own precedent (`services.helium.imput.net`, self-hostable) is the right shape for later: a `helium-sync-server` that imput could host and users could run, behind the same `Store` seam, once the E2E codec exists. The seam is kept: `CodecId`, the plaintext envelope header, and the pairing string all have room for it.

### Host permissions

The manifest declares `optional_host_permissions` for the `https` and `http` wildcards; the install prompt shows neither. On **Connect** or **Join**, inside the click, `chrome.permissions.request` asks for exactly the store's origin. Fetches from the service worker to a granted origin bypass CORS, which is what makes Nextcloud (no CORS headers) work. Requests send `credentials: 'omit'` and an explicit Basic header, never the cookie jar, so a logged-in Nextcloud session cannot trigger its CSRF check. Before every cycle the worker checks `permissions.contains`; a grant revoked in `chrome://extensions` shows as `no-host-permission` with a **Grant** button, not as a CORS error.

### Pairing

`helium-sync:1:<base64url(canonical JSON StoreConfig)>`. It carries the credential and the UI says so in one sentence, with an "include password" toggle for people who would rather type it on device 2. There is no QR in v1: Helium is desktop-only and a desktop has no camera pointed at another desktop (Chromium's `BarcodeDetector` exists on macOS only). The string moves through the user's password manager, which a Helium user already syncs. A QR renderer later is a presentation of the same string.

### Where the engine runs

Only in the service worker, under `navigator.locks.request('helium-sync:engine', { ifAvailable: true })`. Triggers: a 5-minute `chrome.alarms` poll; bookmark events with an in-memory 3-second debounce and a 30-second one-shot alarm as the backstop in case the worker dies first; `history.onVisited` sets a dirty flag and lets the poll collect. The popup sends a message; it never runs the engine. Chromium keeps the worker alive while an API call or fetch is in flight and resets the idle timer per event, so a cycle of a few seconds needs no keepalive. The 90-day history backfill (~17k `getVisits` calls on a real profile, P5) is chunked one day per cycle, newest first, with the cursor persisted after each day; a worker death costs one day's work.

### Local state

IndexedDB, one database with object stores for the device record, per-type register state, per-shard own and peer records, the echo guard, the bookmark id map, and the view sink's visits. Structured clone stores the register layer's `Map`s directly. Each `save` or slot `put` is one transaction, so a worker death between them leaves a consistent prefix that the engine's ordering converges from. Round 1's single `state.json` was split because history made it large and mostly unchanged per cycle. `chrome.storage.local` holds only what the UI reads directly: the store config, settings, and the last `SyncReport`. The popup renders from storage and listens to `onChanged`, so it works with the worker asleep. `unlimitedStorage` plus `navigator.storage.persist()` keeps a 50k-bookmark replica and 90 days of shards from eviction.

### Identity without guids

`ItemId` is a UUID. The adapter owns a permanent `chromeId <-> ItemId` map. Roots are found by `folderType` and pinned to round 1's well-known guids, which are valid ItemIds identical on every device. A node with no entry gets `mintItemId()` during `read`; if adoption pairs it with a synced item, `bind` rewrites the entry, and the minted id was never published. An entry whose chromeId vanished (profile restored from backup) is dropped, the ItemId becomes unclaimed, and adoption or re-creation handles it. A node created by `apply` is mapped right after `chrome.bookmarks.create` resolves; a crash between the two leaves a node that the next read mints an id for and adoption pairs by content, so the duplicate never forms. Round 1's rule stands: id mapping belongs to the adapter, never the engine.

### What "apply" means for history

Three sinks, composed in `chromeHistoryChannel`, each idempotent on event key:

1. **View**, always. Events go into the `visits` store the Synced history page reads: real time, title, transition, device. Zero writes to Helium's history. This is the default, and it is honest.
2. **Address-bar hints**, opt-in, default off. For a URL local history lacks, one `addUrl` so the omnibox can suggest it. Once per URL, never per visit. The entry is untitled and stamped now, which is exactly what the setting's description says.
3. **Companion import**, opt-in file mode. Below.

The echo rule closes the loop: every ingested key is recorded, and `collect` drops local visits whose key is known, so a hint or a companion import never republishes as this device's visit. Deletes are not synced in v1: clearing history on one device does not clear others, and "Delete my synced history" removes this device's shards.

### The opt-in file mode boundary

`adapters/native-host.ts` is the only module that touches `chrome.runtime.connectNative`, and in v1 it is a `HistorySink`, nothing more. Bookmarks already apply with full fidelity through `chrome.bookmarks`, so the companion's one job is the thing no extension API can do: write remote visits into History SQLite with their real `visit_time`. Enabling it requests the optional `nativeMessaging` permission inside the click, then `hello`s the host; the Advanced section shows the one-line install command until that succeeds. The engine never learns the mode exists (rubric 3).

The companion's lifecycle uses P2's facts. Helium spawns it on connect and closes its stdin on quit. While connected it stages visits to a local file. On stdin end it forks a detached child that waits for `SingletonLock` to clear (P1's host, pid, and binary check), inserts visits it does not already hold by `(url, visit_time)` with `visit_source = SYNCED`, and exits. If Helium relaunches first, the child gives up and the staged file waits for the next quit. The imported visits surface to `chrome.history` after restart and the echo rule drops them.

### Interface depth

`Engine` has `sync` and `forget`. Behind `sync`: discovery, conditional manifest fetches, offline fallback to cached peers, hash verification, rollback and clone detection, idle handling, HLC, merge, adoption, GC, the mass-delete guard, shard union and expiry, echo-aware ingest, publish ordering, and crash safety. `Store` has five methods and one error type the popup can speak. `RegisterChannel` and `LogChannel` have three and two. The UI sees `UiStorage` and a `Message` union, and `describe` is the one place a report becomes sentences. HTTP, PROPFIND XML, `BookmarkTreeNode`, `VisitItem`, IndexedDB schemas, and the companion protocol are each private to one file (per boundary-discipline).

### What changed from round 1 and why

| Round 1 | Here | Why |
|---|---|---|
| `ProfileSession` offline / live / read-only, `channelFor`, `WritableProfile`, run state, backups, restore | `Profile.registers` and `Profile.log`; every channel writes | The extension runs only while Helium runs. The capability existed to forbid writes while it ran. |
| `ItemId` = Chromium guid, alias table cleared by the next file rewrite | `ItemId` = UUID, permanent id map | No guid in the API. The map is the adapter's, as round 1 already required of a live adapter. |
| `Store.get(key)`; `meta.json` | `get(key, knownVersion)` → ok / unchanged / missing; `probe`; `StoreError`; `manifest.json` indexes files | Network reads cost a round trip. One 304 per peer replaces N listings. Setup needs typed failures. |
| Store always reachable | Fetch failures set `report.offline`; the cycle runs against last good copies and publishes nothing | A laptop on a train still folds and applies local edits. |
| `DataType` has one shape | `RegisterType` or `LogType`, `model` discriminant | History is facts, not registers. |
| `state.json`, pid lock in `LocalState` | IndexedDB object stores; Web Lock in `background.ts` | Size and transaction granularity; no process to own a pid file. |
| `gzipJson` via `node:zlib` | Same `CodecId`, same bytes, via `CompressionStream` | No `node:*`. A round-1 CLI still reads these files. |

### Module map

```
background.ts                 service worker: alarms, events, Web Lock, messages, adapter wiring
ui.ts                         popup and options page: Message/Reply, describe()
engine.ts                     the cycle (registers: round 1; log: new), SyncReport
  crdt.ts                     round 1, unchanged
  model.ts                    brands, Reg/Entry/Replica/Live, RegisterType | LogType, shardOf
  registry.ts                 { bookmarks, history }, RegisterTypes, LogTypes
  types/bookmarks.ts          round 1, model tag added
  types/history.ts            Visit, history
  store-format.ts             layout, Manifest, envelope, Codec, StateFile, ShardFile
  ports.ts                    Store, Profile channels, LocalState, Clock, StoreError
adapters/store-config.ts      StoreConfig, presets, host permission, pairing code
adapters/webdav-store.ts      Store over fetch
adapters/chrome-bookmarks.ts  id map, RegisterChannel<Bookmark>
adapters/chrome-history.ts    LogChannel<Visit>, the three sinks, echo rule
adapters/native-host.ts       opt-in companion: HistorySink over connectNative
adapters/idb-local.ts         LocalState and IdMap over IndexedDB
```

"When does a sync run?" is `background.ts`. "What is in the store?" is `store-format.ts`. "How does a bookmark reach Helium?" is `engine.ts` and `chrome-bookmarks.ts`. "Where does remote history go?" is `chrome-history.ts`, and `native-host.ts` only if the user opted in.

## Synthesis decision

Filled in by arena.

## Tradeoffs accepted

- We accept that setup needs a WebDAV server and an app password, in exchange for never holding users' plaintext data and shipping no server. Provider presets and the pairing string are the friction budget.
- We accept that the pairing string carries the credential, in exchange for a twenty-second device 2. The toggle lets the cautious type the password instead.
- We accept a plaintext credential in `chrome.storage.local`, like every extension that talks to a server, since v1 has no encryption at rest by decision.
- We accept untitled, now-stamped history entries when the user turns on address-bar hints, in exchange for omnibox suggestions without a companion. Default off, bounded to one per URL.
- We accept that history deletes do not propagate in v1.
- We accept per-day shards (about 90 files per device) and a 15-minute discovery PROPFIND, in exchange for a steady state of one 304 per peer.
- We accept that the companion needs a terminal once. The rubric's "no terminal" is for the default path; file mode is opt-in and advanced.
- We accept, unchanged from round 1, that clock skew can flip LWW and shift idle detection, and that a device idle past 90 days rejoins by adoption and loses its pre-gap deletes.
- We accept that bookmarks have no "restore last sync" in the default mode. The fold rule and the mass-delete guard are the protection; a pre-apply snapshot in IndexedDB is a one-slot addition if it bites.

## Alternatives considered

- **A bespoke `helium-sync-server` in v1.** Shallow: it exposes a deploy and an auth surface to hide what WebDAV already hides. Its two real advantages, server-brokered six-digit pairing and push, are matched by the pairing string and by 304s. Kept as the post-encryption hosted-and-self-hostable shape.
- **Register model for history** (per-visit entries with stamps and tombstones). Doubles the bytes for data nobody edits and forces a full-state rewrite per cycle. The log model hides sharding and expiry behind two channel methods.
- **Change detection by PROPFIND listing** instead of a manifest. Lists every shard of every device each poll (~100 KB XML for three devices) and depends on collection ETags that only some servers propagate. The manifest makes a publish atomic from the reader's view for free.
- **Overriding `chrome://history`** (`chrome_url_overrides.history`) with the merged view. The strongest UX, and a v2 question, but it means re-implementing local history browsing and deletion to replace a page users already know.
- **`addUrl` for every remote visit as the default apply.** P5 called it pollution: it stamps old visits as today and loses order. Rejected as default, kept as the bounded opt-in.
- **Running the engine in an offscreen document or the options page** to dodge worker lifetime. Adds a context and a message hop; alarms plus Web Locks plus crash-convergent ordering already make the worker enough.

## Implementation reconciliation

None yet.

## Open questions and risks

1. **Is WebDAV-only acceptable for v1, with S3 as the first follow-up?** The alternative is shipping both and accepting SigV4 plus XML listing in the first release.
2. **Should the pairing string include the password by default?** The sketch says yes with a toggle; the conservative default is the reverse.
3. **Should the Synced history page eventually replace `chrome://history`?** It changes what the extension is responsible for.
4. **Risk: HTTP auth dialogs.** If a server answers a worker `fetch` with a 401 challenge and Chromium shows a native auth prompt instead of resolving the fetch, status reporting degrades. The sketch sends the header proactively so a correct credential never sees a challenge; this needs a check on Helium 154.
5. **Risk: WebDAV servers that return no ETag** on GET. The adapter then downloads manifests every cycle (~1 KB each), which is acceptable, but `unchanged` is never answered. Known: Apache mod_dav returns ETags; Nextcloud and sabre do; nginx's module does.
6. **Risk: `chrome.bookmarks` rejects some URLs** the merge produces (schemes, length). These stay `partial` forever and the popup shows them; a per-item "drop from sync" action may be wanted.
7. **Risk: service-worker lifetime during the first join on a 50k-bookmark profile.** The round-1 benchmark is 155 ms for the merge; the apply is 50k API calls. If Chromium kills the worker mid-apply, convergence holds (adoption pairs created nodes), but the first join may take several cycles. Measure.
8. **Risk: `optional_host_permissions` wildcards and Chrome Web Store review.** Standard for BYO-server extensions, but review may ask for the justification text.

## Next implementation step

Port P3's `scenarios.ts` to drive `createEngine` through an in-memory `Store` that can answer `unchanged`, go offline, and tear a PUT, and a fake `Profile` whose bookmark channel mints ids like the chrome adapter and whose history channel replays P5-shaped visit days, asserting convergence after a worker death at every `await` in the cycle.
