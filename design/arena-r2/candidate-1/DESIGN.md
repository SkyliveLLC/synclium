# helium-sync as an MV3 extension: bring your own folder

Candidate 1, arena round 2. Sketch in `sketch/` (`npx -y -p typescript tsc -p sketch --noEmit` passes under `--strict`).

## Problem

helium-sync is now a Chrome Web Store extension for Helium. It syncs bookmarks (v1) and history (type 2) between one user's devices, with no server. Round 2's decisions bind this design: the extension is the product, profile files are written only in an opt-in mode, v1 has no encryption, and history comes second.

Three constraints make the shape non-obvious:

- **The store has to be reachable from an extension.** This candidate uses a folder the user already syncs (iCloud Drive, Dropbox, Syncthing), reached through the File System Access API. The handle is picked once in an extension page and saved in IndexedDB. Nobody has verified that the folder permission survives a browser restart, or that the service worker can use the handle. The design has to work, honestly degraded, if either fails.
- **The extension API is not the file adapter.** P2 showed that `chrome.bookmarks` exposes no guid and rejects a caller-chosen id, so sync needs its own `ItemId` to chrome id map. P2 also showed that `history.addUrl` cannot set a visit time. The MV3 service worker can be terminated between any two awaits.
- **History is big.** P5 measured 46k visits over 90 days, about 1.9 MB gzip as a full-state file per device. That is too large to rewrite every cycle, so history must be sharded.

Round 1's register layer, per-device files, fold rule, adoption, and Store contract are proven by P3. They carry over unchanged unless the runtime breaks them. The [carry-over table](#what-carried-over-from-round-1) lists what changed and why.

## Usage (caller's view)

### What the user does

**Device 1, about 40 seconds.** The user clicks "Add to Helium" on the Chrome Web Store, and the install opens `app.html#setup` in a tab.

1. "Choose a folder you already sync: iCloud Drive, Dropbox, Syncthing." The user clicks [Choose folder], picks *iCloud Drive* in the native picker, then clicks Allow in Chromium's "Let Helium Sync edit files?" prompt.
2. Setup shows "New sync folder: Helium Sync" and a device name field prefilled with "Mac". The user clicks [Start syncing].
3. Setup reports "Published 512 bookmarks and 90 days of history."

**Device 2, the same steps.** The user picks *iCloud Drive* again, and step 2 says "Joining conan-mbp." The report then says "Matched 498 bookmarks you already had, added 14, published 37." Adoption by content prevents duplicates. The user can pick either the parent folder or `Helium Sync/` itself, because setup finds the store in both cases.

**Steady state needs no action.** Bookmark edits publish about 30 seconds after the last change. Peers' changes arrive within 5 minutes. The toolbar badge stays blank. The popup says "Synced 2 min ago with 1 other device" and has [Sync now] and [Open].

**Peers' history** appears in the app page's History tab and behind the omnibox keyword `hs` (`hs rust async` suggests pages visited on other devices). It is not added to Helium's own history. See [History](#history-owner-shards-not-replicas).

**After a restart, if Chromium drops the folder grant**, the badge shows `!`. The popup says "Paused until you allow access to Helium Sync" and has an [Allow access] button. The button opens `app.html#allow`. One click there, plus Chromium's prompt, resumes sync. Edits made while paused are already stamped and committed locally, and they publish on the next cycle. [Permission ladder](#the-permission-ladder) has the details.

### The service worker wires the engine (`background.ts`)

```ts
const engine = createEngine({
  connect: connectFolder,            // re-checked every cycle: ready | needs-permission | missing | not-set-up
  bookmarks: chromeBookmarks(),      // Channel<Bookmark>, owns the chrome id map
  history: chromeHistorySource(),    // read-only view of chrome.history
  historyDb, local: indexedLocal(), codec: gzipJson, clock: Date,
  platform: () => chrome.runtime.getPlatformInfo().then((i) => parsePlatform(i.os)),
  appVersion: chrome.runtime.getManifest().version,
});
chrome.alarms.onAlarm.addListener(() => void cycle());   // 'poll' every 5 min, 'soon' 30 s after a bookmark event
```

### The setup page

```ts
pickButton.onclick = async () => {
  const chosen = await chooseFolder();          // picker + edit prompt; finds or creates "Helium Sync/"
  render(chosen.devices.length ? `Joining ${names(chosen.devices)}` : 'New sync folder');
  startButton.onclick = async () => {
    await chosen.confirm(nameInput.value);       // saves the handle, mints the DeviceId, under the Web Lock
    render(await ask({ kind: 'sync-now' }));     // typed reply: SyncReport
  };
};
```

### A test, in Node, with no browser

```ts
const engine = createEngine({ connect: async () => ({ access: 'ready', folder: 'mem', store: memoryStore() }),
  bookmarks: fakeChannel(tree), history: fakeHistory(visits), historyDb: memoryHistoryDb(), local: memoryLocal(), ... });
const r = await engine.sync();
assert(r.kind === 'cycle' && r.bookmarks.kind === 'synced');
```

The engine imports no `chrome.*` or File System Access type, so P3's scenarios port over directly. The new scenarios are "worker killed mid-apply" and "folder access lapses mid-session".

## Shape

### What carried over from round 1

| Round 1 piece | Verdict in MV3 |
|---|---|
| Register layer (`model.ts`, `crdt.ts`), fold rule, adoption, GC, rollback and idle rules, mass-delete guard | Kept as is. The files are copied, not edited. |
| Per-device files, envelope, `StateFile`, `DeviceMeta` | Kept. Files are named `.hsync`, not `.json.gz`, because an archive extension can trip Chromium's download-protection check when a File System Access writer closes. History shard keys are new. |
| `Store` port (`list/get/put/delete`, one writer per key, atomic put) | Kept. `StoreEntry` gains `version` (lastModified + size) and `downloaded`. `watch` is dropped, because a sleeping worker cannot hold a watcher. |
| `Profile.open()` with offline / live / read-only sessions, `channelFor`, the `WritableProfile` capability | **Removed.** Inside the extension, Helium is always running and `chrome.bookmarks` always writes. R1's `WriteChannel` survives as `Channel<R>`. |
| `Registry`, `TypeName`, `RecordOf` | **Removed.** Two types with different shapes gain nothing from a registry. Bookmarks is a replica type. History is not (below). |
| `LocalState` with pid lock and `state.json` | IndexedDB plus a Web Lock. The browser releases the lock when the worker dies, so no stale lock can exist. |
| File adapter alias table behind `bind` | The chrome id map behind the same `read`/`bind` contract. |
| launchd daemon, CLI | The service worker with `chrome.alarms` replaces the daemon. The popup and app page replace the CLI. |
| Backups and `restore` | Dropped from v1. With no profile file writes, there is nothing to back up. The mass-delete guard stays. |
| History as a full-state merge type through the file adapter | **Replaced** by owner shards. Real visit times move to the opt-in companion. |

### Where the engine runs

The engine runs in the service worker, and every trigger is persistent. That covers the `poll` alarm (every 5 minutes), the one-shot `soon` alarm (re-armed by each bookmark event, so a burst of edits becomes one cycle), `onStartup`, `history.onVisitRemoved`, and UI messages. Listeners register synchronously at top level. Top-level await is illegal in a worker, so `platform` is lazy.

A cycle takes the Web Lock `helium-sync`, so the worker and the setup page never interleave. A trigger that arrives during a cycle waits, then runs a cycle that does nothing. Extension API calls reset the worker's idle timer. A long cycle, such as a 17k-call history re-derive, keeps the worker alive this way. The design still assumes termination at any await, and round 1's ordering covers that case. `own` is committed before publish. `applied` moves only on proof. Adoption claims bookmark nodes an interrupted apply created before their ids were saved. File System Access `close()` renames a `.crswap` file into place, so a kill mid-write leaves a stray swap file, which `parseKey` reports as foreign. It never leaves a torn file.

No native port is held to keep the worker alive (P2 showed that this works). In the default mode, holding one would require the companion.

### The store: a folder through File System Access

`folder-store.ts` owns every folder and permission hazard. `FileSystemHandle` types appear only there and in `local.ts`'s kv schema.

- `chooseFolder()` runs in the app page, inside a click handler. It calls `showDirectoryPicker({ id: 'helium-sync', mode: 'readwrite' })`. The store is the picked folder if it has `devices/`, or its `Helium Sync/` child if that has `devices/`. Otherwise the function creates `Helium Sync/`. It returns a preview of the existing devices, plus `confirm(name)`.
- `connectFolder()` runs in any context and never prompts. It loads the handle from IndexedDB and calls `queryPermission`. The result is a `StoreConnection` union, and a `Store` exists only in the `ready` variant. No code path can write without access, and the compiler enforces it.
- `allowFolder()` runs in the app page, inside a click handler, and calls `requestPermission`.
- The popup never touches File System Access. The native picker and Chromium's permission bubble take focus and close the popup. A request tied to a closed frame is cancelled.
- File System Access never reveals a path. The UI shows only the folder name ("Helium Sync").

### The permission ladder

This is the unverified core of this direction. Every rung keeps the engine, the store format, and the UI states unchanged. A rung changes only who calls the four `Store` methods, and what the user occasionally clicks.

| What verification finds | What the user sees | How sync degrades | Change to the design |
|---|---|---|---|
| **A.** The worker can use the handle, and the grant survives restarts | Nothing after setup | Not at all | None |
| **B.** The grant lapses at restart, and Chromium's re-prompt offers "Allow on every visit" | One time, after the first restart: badge `!`, then [Allow access], then "Allow on every visit" | Until that click, cycles run local-only (below) | None |
| **C.** The grant lapses at every restart, with no persistent option | The same click after every browser start | Local-only from each launch until the click | None in code. Q1 asks whether this is acceptable. If not, go to E. |
| **D.** The worker cannot use the handle (no File System Access in the worker, or `prompt` in the worker while the page has `granted`) | As A, B, or C | As A, B, or C | Store calls move to an offscreen document that implements the same `Store` over runtime messages, about 100 lines. The engine stays in the worker. No offscreen reason names file access, so `BLOBS` would be the justification, which is a CWS review risk. |
| **E.** The folder is unusable (Helium's picker blocks cloud folders, or C is rejected) | A one-time companion install | Not at all after the install | The companion's native host serves the `Store` by path over native messaging. It is the same companion as file mode. The default is then no longer API-only, and that is the cost. |

A **local-only cycle** is what makes B and C tolerable. When the store is not `ready`, the engine still reads the profile and merges `own` with each peer's last good copy. It stamps local edits, commits them, and scans history into own days. It skips only publishing and pulling. When access returns, the next cycle publishes the backlog: bookmarks through `pushedHash`, history days through `pushedRev < rev`. Edits carry stamps near the time they were made. Without local-only cycles, an edit would be stamped when the folder came back and could wrongly win last-writer-wins against a peer's newer edit.

Rung **missing** is separate from the ladder. If the folder was moved or deleted, `getDirectoryHandle` throws `NotFoundError`. The popup then says "Can't find Helium Sync" and offers [Choose folder]. Choosing again runs `local.reset`, which mints a new DeviceId, and the device joins by adoption.

Chromium's blocklist (as I recall it; unverified in Helium) refuses the home folder and `~/Library`, but allows `~/Library/Mobile Documents` (iCloud Drive) and `~/Library/CloudStorage` (Dropbox, OneDrive). The P7 probe checks this along with persistence.

### Local state

There is one IndexedDB database, shared by the worker and the pages because they have the same origin (`local.ts`). It uses IndexedDB rather than `chrome.storage.local` because IndexedDB stores `Map`s and directory handles as structured clones. It can also commit several records in one transaction and index peer visits for search.

- `kv`: `device` maps to `DeviceLocal` (round 1's shape, plus small `HistoryLocal` metadata), and `folder` maps to the handle.
- `idmap`: chrome id maps to `ItemId`, with a unique index on `ItemId`.
- `ownDays`, `peerShards`, and `peerVisits` hold history payloads. They stay out of `DeviceLocal`, so a cycle never rewrites megabytes.

`chrome.storage.local` holds one derived value: the last `SyncReport` and the companion status. The popup renders from it and re-renders on `storage.onChanged`, which never wakes the worker.

### Bookmarks: the id map and live apply

Round 1 put id mapping in the adapter, so `chrome-bookmarks.ts` owns it.

- **`read`** walks `getTree()`. Roots map by `folderType` (`bookmarks-bar`, `other`, `mobile`) to round 1's well-known root ItemIds. That mapping `satisfies` an exhaustive type over chrome's `FolderType`, minus `managed`, so a new folder type fails to compile. Managed and unmodifiable nodes are skipped. A known chrome id resolves through `idmap`. An unknown one gets `crypto.randomUUID()`, and the row is saved before `read` returns, so a crash never mints a second id for the same node. Child indexes become fractional positions through round 1's `placeChildren`.
- **`bind`** applies adoption's aliases (minted id to synced id), so a node created locally before join, or by a crashed apply, takes over the synced id.
- **`apply`** runs `planApply(current, target)`, a pure, testable list of ops. Creates run parents first, and each create's map row is saved immediately. Updates follow, then moves (per folder in target order), then removes (children first). Any throw returns `interrupted`, and `applied` stays put. The next cycle recomputes from what the profile shows. Our own calls fire bookmark events, which schedule one more cycle. That cycle finds `observed == applied` and does nothing.

If Chromium ever reassigns chrome ids (a corrupt-file repair), every node reads as unknown, and adoption rebinds them by content. This is round 1's single recovery path, with no new code.

### History: owner shards, not replicas

A visit is an immutable fact with exactly one author. A register replica is the wrong shape for it, so history skips HLC, tombstones, and merge:

- **Each device publishes only its own visits**, sharded by UTC day: `devices/<id>/history/<yyyy-mm-dd>.hsync`, holding `{ device, day, rev, visits: {url, title, t}[] }`. Readers take the union. P5 puts a day shard at about 20 KB gzip, so a normal cycle uploads at most today's shard. Joining uploads up to 90 shards, about 1.9 MB, once.
- **Capture is a scan, not an event log.** Each cycle reads `[watermark - 60 s, now)` with `history.search` (urls visited in range) and `getVisits` per url, keeping `isLocal`, http(s) visits. `foldScan` unions them into own days. A crash re-scans, and the `url + t` key dedupes.
- **Local deletes propagate by re-derivation.** `onVisitRemoved` cannot describe a partial range delete (it lists only fully removed urls), so any removal event sets `rederive`, and so does a weekly timer. The next cycle rebuilds every own day from Helium's history, which takes about 17k `getVisits` calls, rarely. A deleted visit leaves its owner's shard. Peers see the shard's version change and replace their index entries. No tombstones are needed, because only the owner ever held the visit in a file.
- **Retention is 90 days**, matching Chromium. Owners delete their expired shards. Readers drop expired index entries, and drop the entries of any shard a live peer no longer lists. Readers ignore idle peers' shards, which are expired by then anyway.
- **Rollback**: a shard whose `rev` is lower than the indexed one is ignored, with a warning. Merging it could resurrect a visit the owner deleted.
- **What "apply" means**: peers' visits go into the IndexedDB index, which the History tab and the omnibox keyword search. helium-sync **never calls `history.addUrl`**. It would stamp every remote visit "now" and flood today's history. Real visit times in Helium's own history are the companion's job.

### Opt-in file mode: the companion

`companion.ts` is the boundary, and nothing in the engine, store, or history step imports it. A user who wants peers' visits in Helium's own history, at their real times, turns on a toggle in `app.html#advanced`. The extension requests the optional `nativeMessaging` permission and links to a download (`.pkg` or tarball). The download installs two things:

- **host**: a native messaging host that Helium spawns. After each cycle, the worker sends it the peer-visit index as desired state per shard (`shard` and `drop` messages, deduped by the `rev` the host reports holding). The host writes the mirror to disk. It never touches the profile.
- **agent**: a launchd or systemd unit. When Helium is closed (round 1's host + pid + binary check), it reconciles History SQLite to the mirror. It inserts mirrored visits at their real `visit_time` and deletes visits it inserted whose shard dropped them. It never deletes a visit Helium made, never writes Bookmarks, and never writes the store.

There is a reason for a mirror instead of giving the companion the folder. File System Access never reveals the folder's path, and a second store reader would need the store format, device ids, and rollback rules. The only coupling back into sync is one generic rule in `history.ts`: a local visit some peer already published is not republished (`HistoryDb.knownFromPeers`).

### Invariants the compiler holds

- A `Store` exists only in `StoreConnection`'s `ready` variant. `StoreStatus`, the UI's view, is derived from it with a distributive `Omit`, so a new access state reaches the popup's `viewOf` switch.
- `UiMessage` and `UiReply` derive from one `Protocol` map. The worker's `handle()` is exhaustive with a `never` default, and `ask()` returns the reply type of the message it was given.
- `ROOT_BY_FOLDER_TYPE` is exhaustive over chrome's `FolderType`.
- `ItemId`, `ChromeId`, `DayKey`, `VisitKey`, `Hlc`, `DeviceId`, and `StoreKey` are branded, and only predicates and parsers mint them. Round 1's distributive `Entry` keeps a folder from having a `url` register.
- Not in types: "call `chooseFolder` and `allowFolder` only from a click handler." That rule is documented, and a misuse fails loudly at runtime with Chromium's `SecurityError`.

### Interface depth

- `Engine` has three methods: `sync`, `historyRemoved`, and `forget`. Behind them sit access checks, local-only cycles, round 1's whole merge pipeline, shard bookkeeping, and crash ordering.
- `Store` has 4 methods. `Channel` has 3. `HistorySource` has 1 (`visitsBetween`).
- `folder-store.ts` exports 3 functions: choose, connect, allow.
- `HistoryDb` is the widest port, with 10 members, and it is a persistence port with no policy. The policy lives in `syncHistory`.
- Wire and storage types (`StateFile`, `HistoryShard`, the envelope, IndexedDB rows, chrome nodes, and the companion messages) stay private to the module that owns them.

### Module map

```
background.ts        worker: listeners, alarms, report -> chrome.storage + badge, UI message handler
engine.ts            the cycle, SyncReport                 <- the deep module
  model.ts crdt.ts   round 1 register layer (verbatim)
  bookmarks.ts       round 1 Bookmark type, adopt, normalize, placeChildren (verbatim)
  history.ts         Visit, DayKey, foldScan, syncHistory, chrome.history source
  store-format.ts    keys, envelope, codec (CompressionStream), StateFile, HistoryShard, DeviceMeta
  ports.ts           Store, StoreConnection, Channel, HistorySource, LocalState, HistoryDb
folder-store.ts      File System Access: choose, connect, allow, folderStore
chrome-bookmarks.ts  Channel<Bookmark>, chrome id map, planApply
local.ts             IndexedDB schema, LocalState, HistoryDb, idmap, Web Lock
ui.ts                popup + app page, UiMessage protocol, viewOf, badgeFor
companion.ts         opt-in boundary: mirror protocol to the native companion
manifest.json        bookmarks, history, storage, unlimitedStorage, alarms; optional nativeMessaging; omnibox "hs"
```

Each of these questions is answered by at most three files:

| Question | Files |
|---|---|
| Can we reach the folder right now? | `folder-store.ts` |
| Why didn't my edit sync? | `engine.ts`, `chrome-bookmarks.ts` |
| What is in the folder? | `store-format.ts` |
| How does history move? | `history.ts`, `local.ts` |

## Synthesis decision

*Filled in by arena.*

## Tradeoffs accepted

- We accept a possible one-click resume after a browser restart (rungs B and C) in exchange for using a folder the user already syncs, no server, and no install beyond the Web Store.
- We accept that peers' history is visible in our History tab and omnibox keyword but not in Helium's own omnibox ranking or `chrome://history`. In exchange, Helium's local history is never polluted with fake "now" visits. The companion closes the gap for users who opt in.
- We accept a full re-derive of own history (about 17k API calls) on any history deletion, in exchange for exact delete propagation with no tombstones.
- We accept plaintext bookmarks and history in the user's cloud folder in v1 (Conan's decision). History is the more sensitive of the two. Q2 asks how setup should say so.
- We accept that history is not a register replica. A reader might take this for a missed reuse. It is deliberate, because owner-authored immutable facts need neither merge nor tombstones.
- We accept that a peer's history disappears from our index when it goes idle or its shards expire. History is a 90-day window by nature.
- We keep `version`-based skipping of unchanged peer files for bookmarks too. It looks like premature optimization at 31 KB, but it is free once `StoreEntry` carries `version`, and the worker polls every 5 minutes.

## Alternatives considered

- **History as a round 1 replica type (per-url registers, tombstones).** Lost on size and on fit. A full-state file per device is 1.1 to 1.9 MB rewritten each cycle (P5). Deletes would need tombstones for data that has exactly one author.
- **Apply remote history with `history.addUrl`.** Lost because every remote visit lands at "now", and an import floods today's history. One addUrl per remote url (not per visit) would shrink the flood but still put misdated rows in `chrome://history`.
- **Run the engine in the app page or an offscreen document by default**, where File System Access is certainly available. Lost because sync would then run only while a tab is open, or would depend on an offscreen reason CWS may reject. It stays rung D, not the default.
- **Hold a native messaging port to keep the worker alive (P2).** Lost because it requires the companion in default mode. Alarms plus idempotent cycles make worker lifetime irrelevant.
- **OPFS or `chrome.storage.sync` as the store.** OPFS does not leave the machine. `chrome.storage.sync` rides Google sync, which Helium does not have, and its quota is about 100 KB.

## Implementation reconciliation

None yet.

## Open questions and risks

### Decisions for you

1. **If verification lands on rung C (one click after every browser start), is that acceptable, or do we go to rung E** (companion as the store, an extra install for everyone)? My recommendation is to accept C for v1. Sync loses nothing in the meantime, because cycles run local-only.
2. **Should history be on by default, given no encryption?** My recommendation is yes, with setup step 2 stating it in one line: "Bookmarks and the last 90 days of history are stored unencrypted in this folder." A per-type toggle is easy to add if you want one.
3. **Is the companion (file mode) v1 or v1.1?** It touches only `companion.ts` and one line in `background.ts`, so it can ship later with no engine change. My recommendation is v1.1.

### Risks

- **Every File System Access claim is unverified in Helium.** That includes worker access, grant persistence, the cloud-folder blocklist exceptions, and download-protection behavior on `close()`.
- **iCloud eviction.** "Optimize Mac Storage" can leave a peer file as a `.name.icloud` placeholder that File System Access cannot materialize. The store reports it as `downloaded: false`, which reads as "not yet", never as deleted. Status names the file. Whether iCloud re-downloads it unattended is unknown.
- **The `history.search({ maxResults: 0 })` meaning of "no limit"** and the cost of 17k `getVisits` calls are unmeasured.
- **The 30-second alarm minimum** for store-installed extensions sets the floor for bookmark publish latency.
- **Profile copy.** A copied Helium profile copies IndexedDB too, so two machines share a DeviceId. Round 1's `identity-clash` block catches it. The fix in the UI is "Forget this device" followed by setup.
- **`folderType`** requires Chrome 134 or later. It was observed in Helium 154, and `minimum_chrome_version` is set to 134.

## Next implementation step

Build P7, a 40-line unpacked extension that picks iCloud Drive and Dropbox folders in a tab. From the worker, it reads the handle from IndexedDB, calls `queryPermission`, and writes a file, across two Helium restarts. That pins the ladder rung before anyone writes `folder-store.ts`. After P7, port P3's scenarios onto `createEngine` with in-memory ports, adding "worker killed mid-apply" and "access lapses mid-session".
