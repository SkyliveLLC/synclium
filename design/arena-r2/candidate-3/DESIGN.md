# helium-sync as an MV3 extension (arena round 2, candidate 3)

Direction: the service worker is a stateless, killable cycle runner. Round 1's engine is reused whole. A folder store (File System Access) is the default, WebDAV is the second adapter behind the same port. Remote history lives in an extension-side corpus you can search, and the opt-in native host upgrades it to a real history merge. Sketch: `sketch/` (`npx -y -p typescript tsc -p sketch --noEmit` passes under `--strict`).

## Problem

Helium has no sync. The product is now a Chrome Web Store extension that syncs bookmarks and history using only extension APIs. Four facts from `grounding.md` shape it:

- The engine from round 1 (per-device files, HLC registers, fold rule, adoption, acked GC) is proven by P3. It was built to survive a crash at any line.
- `chrome.bookmarks` has no guid (P2), and `history.addUrl` cannot set a visit time (P2). Writing remote visits through it stamps them "now".
- History is big: 46k visits, 1.9 MB gzip as one file per device. It must be sharded (P5).
- An MV3 service worker dies after 30 s idle or 5 min in one event, and it dies in the middle of whatever it was doing.

The user's decisions are binding: the extension is the product, direct profile-file writes are opt-in, no encryption in v1, history is type 2.

## Usage (caller's view)

### README quickstart

1. Install **Helium Sync** from the Chrome Web Store ("Add to Helium"). A setup tab opens by itself.
2. Click **Choose sync folder**. Pick a new folder inside iCloud Drive, Dropbox, or anywhere your computers already share files. Chrome refuses a cloud root, so the page suggests "make a `Helium Sync` folder".
3. The page runs a dry run and shows the result: "First device. 512 bookmarks will be published." Click **Start**. Done.

On the second device, the same two clicks. The page now says "Found conan-mbp. 498 bookmarks already match, 14 will be shared, 37 will be added here." Then nothing else to do. Edits publish about five seconds after you make them. Other devices' changes arrive within two minutes.

The popup shows state, one line per type, and never needs to be opened:

```
Helium Sync            Synced, 2 min ago
Bookmarks              412
History                Remote history is searchable (3 devices)      [Open history]
Devices                conan-mbp, conan-mini, conan-old (idle 120 days)
```

When something needs a human, it says so and offers one button: "Folder access expired, [Reconnect]", or "This device just lost 61% of its history. Sync the deletion to your other devices? [Yes] [No]".

Remote history is reached two ways. Type `hs` and a space in the address bar, then `rfc 9110`: up to five suggestions with title, host, and day. Or open the **History** page from the popup: day-grouped, searchable, every device's visits, with a remove button per visit.

### The worker wires the engine (`runtime/worker.ts`)

```ts
const scheduler = createScheduler({
  counters: idbCounters(), wake: chromeWake, now: Date.now,
  runCycle: async (budget) => {
    const settings = await readSettings();
    const store = settings.store.kind === 'folder' ? fsaStore(idbHandleVault()) : webdavStore(settings.store);
    const link = settings.fileMode ? connectHost() : null;           // the whole file-mode boundary
    const profile = {
      bookmarks: chromeBookmarks({ device, ids: idbIdMap(), maxWritesPerApply: 90 }),
      history: link === null ? history : withNativeHistory(history, link),
    };
    const report = await createEngine({ registry, store, profile, local, codec: gzipJson, ... }).sync({ budget });
    await writeStatus({ ..., last: report });
    return report.complete ? { kind: 'complete' } : { kind: 'partial', retryInMs: 60_000 };
  },
});
chrome.bookmarks.onCreated.addListener(() => scheduler.request('bookmarks'));   // every listener, top level
```

### A page and a test

```ts
// popup.ts: render, do not compute
const status = await chrome.storage.local.get('status');
render(popupView(settings, status));              // pure, ui/view-model.ts
await call('sync-now', {});                       // typed RPC, wakes the worker if asleep

// history.ts: read the corpus directly, no worker round trip
const hits = await (await openCorpusReader()).search({ text: 'rfc', limit: 50 });

// test: engine with an in-memory Store, a fake Profile, and a Budget that expires after N shards
const r = await engine.sync({ budget: expireAfterShards(3) });   // r.complete === false, rerun converges
```

## Shape

### What carried over from round 1, and what changed

The engine design survives the move. Nothing about the register layer, per-device files, HLC stamps, the fold rule, adoption, acked tombstone GC, rollback detection, idle eviction, the mass-delete guard, or the plaintext envelope with a codec seam needed to change. `model.ts`, `crdt.ts`, `types/bookmarks.ts`, and `store-format.ts` are copies of round 1 with the edits below, each marked `CHANGED` in the file.

| Round 1 | Round 2 | Why |
|---|---|---|
| Daemon, launchd, pid lock, `watch` | Service worker, `chrome.alarms`, Web Lock | No process of ours exists. The browser is the host. |
| `ProfileSession` with `offline`, `live`, `read-only` modes and `channelFor` | `Profile` is a record of write channels. No modes. | The extension is always live. The mode that existed because "Helium might be running" is gone. |
| `file-profile.ts`: `WritableProfile`, run-state check, backups, atomic rename | Moves to the optional host, shrunk to the History database | Default mode writes nothing outside the API. |
| One state file per type per device | One per type, per shard, per device (`devices/<id>/history/2026-10-06.json.gz`) | History is 46k visits. |
| `DataType` has four members | Adds `shardOf` and `expired` | History needs a shard function and a 90-day window. |
| `engine.sync` is unbounded | Takes a `Budget`, stops between shards, reports `complete` | The 5-minute event cap. |
| Bookmark `ItemId` is the Chromium guid | Derived ids plus a map for remote-origin nodes | No guid via API. |
| `LocalState` is `state.json` plus a pid lock | Per-shard IndexedDB commits. The lock left the port. | Multi-record transactions, and "who may cycle" is a runtime question. |
| node:zlib, node:crypto | `CompressionStream`, WebCrypto (so `seal`, `open`, `plaintextHash` are async) | No node in a worker. |
| `Store` has `watch` | `access()` and `StoreEntry.version`; no `watch` | No change events from a folder or a server. |

The deleted rows are the point of the round. The CLI design had a lock, a run-state detector, a write capability, backups, and a daemon, all to write one file safely. The extension API removes all of it from the default path.

### MV3 runtime: a cycle that survives being killed

**The worker holds nothing.** `createEngine` is built fresh on each wake from IndexedDB and `chrome.storage`. Termination mid-cycle is therefore the same event as a crash mid-cycle, which round 1 already handled. The crash table (end of `engine.ts`) covers each await: before the pre-publish commit, after commit before upload, during upload, after upload before `pushedHash`, mid-apply, after apply before `applied`, mid corpus write. In every row the rerun converges, because published bytes are a pure function of peer files, profile content, and local state.

**Triggers cannot be lost** (`runtime/scheduler.ts`). Two durable counters, `requested` and `completed`, make "something is wanted" level-triggered: `requested > completed`. `request(trigger)` bumps `requested` in an IndexedDB transaction first, then arms a debounce timer for latency and a one-shot `resume` alarm as the durable backstop. A `setTimeout` does not survive termination and an alarm does, so the timer gives speed and the alarm gives the guarantee. `completed` advances only to the value of `requested` read before the cycle began. A bookmark edit during a cycle therefore stays pending and loops.

**One drainer at a time.** All cycles run under a Web Lock (`navigator.locks.request(name, { ifAvailable: true })`). The browser releases a lock held by a dead context, so there is no stale-lock takeover to write. A request that finds the lock held returns at once, and the holder re-checks `requested > completed` before releasing, so the loser's already-persisted request is not lost. In practice the worker is the only engine runner. The lock covers overlapping worker lifetimes: an extension update starting a new worker while the old one finishes, or a restart after a crash.

**Worker and pages share nothing writable.** Each piece of state has exactly one writer:

| State | Where | Writer | Readers |
|---|---|---|---|
| Settings | `chrome.storage.local['settings']` | pages | worker, at the start of each cycle |
| Status and last report | `chrome.storage.local['status']` | worker | pages, live via `storage.onChanged` |
| Engine state, counters | IndexedDB `helium-sync-state` | worker, inside the lock | none |
| History corpus | IndexedDB `helium-sync-corpus` | worker, inside the lock | pages and omnibox (read-only) |
| Folder handle | IndexedDB `helium-sync-handles` | setup page | worker |

Pages never run the engine. They call a typed RPC (`sync-now`, `preview`, `confirm-mass-delete`, `forget-visits`, `remove-device`), which also wakes a sleeping worker. A page that wants to search history reads the corpus directly and works while the worker sleeps. There is no cross-context mutation to coordinate (per separate-before-serializing-shared-state).

**Staying inside the limits.**
- The 30 s idle timer resets on any `chrome.*` call, not on IndexedDB, FSA, or fetch. While a cycle runs, `keepAlive()` pings `chrome.runtime.getPlatformInfo()` every 20 s.
- The 5-minute per-event cap is handled with a `Budget` of 4 minutes, shared across the whole wake. The engine checks it between shards, and every shard commits on its own, so stopping loses nothing. A `partial` result re-arms `resume`. A first history sync of 90 days finishes in a few chained wakes, newest day first, so recent history is searchable early.
- `chrome.bookmarks` allows 1000 writes per hour and 100 per minute (verify the constants on Helium 154). Applying a large remote bookmark set therefore takes a while. `apply` does at most 90 operations and returns `deferred: quota`. The pending diff is recomputed from the tree each cycle, so no queue exists. Joining a second device with mostly matching bookmarks is unaffected, because adoption leaves a small remainder. Importing thousands of new ones takes hours, and the popup says "Adding 4,588 bookmarks, Helium allows about 100 a minute."
- Alarms re-register on every wake (`ensureAlarms`), because they may not survive a browser restart. A 2-minute `poll` alarm is how peer changes are noticed. The listing is a stat per file (about 100 per peer with 90 history days). If that proves costly, peers can publish a heads list in `meta.json`. Not v1.

**Failure handling is typed, not thrown.** `Store.access()` is a preflight returning `ok | needs-access | unreachable`. A lapsed folder grant is a normal outcome (report `store` set, badge "!"), not an error, and the poll alarm re-checks cheaply. Only bugs reach `lastError` and the 30 s to 15 min backoff.

### Local state and the id map

Engine state is IndexedDB, not `chrome.storage.local`: multi-record transactions (`own`, `seq`, and the clock must commit together), structured clone for Maps, and no 10 MB cap. `LocalState.commit` is one readwrite transaction, which is the atomic unit commit-then-publish needs. Round 1's `TypeLocal` becomes `ShardLocal`, with the same fields plus a `version` on each `PeerCopy` so an unchanged peer file skips fetch and decode. Memory stays bounded because the engine loads one shard's local state at a time. Losing the database (the user clears extension data) is a clean reinstall: new DeviceId, adoption on rejoin, and the old id idles out after 90 days.

**Bookmark identity without guids** (`adapters/chrome-bookmarks.ts`). Chrome ids are numeric, local, monotonic, and never reused.
- A node this device created or first saw gets `deriveId(device, chromeId)`. It is a pure function, so it needs no stored state and is stable across a kill.
- A node created here by applying a remote item has a remote-given `ItemId` and a `create`-returned chrome id. Only these are stored, in an adapter-private `IdMap`.
- Roots map by `BookmarkTreeNode.folderType` to round 1's well-known guids.
- If the map is lost, or a kill lands between `create` and the map write, those nodes reappear as local items with derived ids. Round 1's content adoption `(parent, kind, title, url)` re-binds them. Adoption stays the single recovery path, which is why the map can stay small and the engine never knows it exists.

### The store

Default is a folder the user picks once (File System Access). It needs no account, and nothing of ours holds a copy of their URLs. That matters with no encryption in v1. The split follows the API: `showDirectoryPicker` and `requestPermission` need a user gesture, so they live in `setup.html`. The worker holds the handle from IndexedDB and does all reads and writes. `put` is atomic because a writable stream writes to a swap file and swaps on close, so a worker killed mid-write leaves the old bytes.

**Unverified gate.** Does the handle stay writable from the worker after a browser restart? The design does not depend on the answer. If the grant lapses, `access()` returns `needs-access`, the popup offers one button, and the setup page's `reconnect` is one click. If lapses turn out to be common, `webdav-store.ts` becomes the default. It is fetch-only, needs no gesture, and has the same four verbs. Nothing above the `Store` port changes. I ship the folder first because WebDAV needs a server, and that server would see plaintext URLs.

### The extension UI surface

Four pages, none computing anything. Each is DOM over a pure function in `ui/view-model.ts`, so every visible state is a variant of a union.

- **setup.html** (`options_ui`, opens in a tab, and opens itself on install). The picker needs a full page, because a popup closes when the system dialog takes focus. Flow: choose folder, dry-run preview via the `preview` RPC (`joinPreview`), toggles per type, Start. The same page hosts `reconnect`, the WebDAV form, and the file-mode opt-in.
- **popup.html** renders `popupView(settings, status)`: setup, needs-access, store-unreachable, or ready with a row per type and the device list. The only buttons are Sync now, Reconnect, and Confirm mass delete.
- **history.html** searches the corpus. Day-grouped, newest first, text filter, and a per-visit "remove from synced history".
- **Omnibox** keyword `hs`.

The toolbar badge shows "!" for needs-access and a count for a blocked type, and is empty otherwise.

### History

**Records and identity** (`types/history.ts`). A record is one immutable visit `{url, title, time, via}`. Its `ItemId` is a hash of `(url, time)`, written into the format (FNV-1a 64). One id for one visit, on every device and in every path. Three consequences follow:
- Echoes are harmless. Reading a visit back after anything imported it yields the same id, so the fold sees `observed == merged` and stamps nothing.
- File mode is idempotent (below).
- No id map is needed.

`parseRecord` accepts only `http(s)` urls. The corpus page opens urls that came from a peer's file, so `javascript:` and `file:` must never survive the boundary.

**Sharding.** `shardOf` is the UTC day of the visit, so every device files a visit in the same file. Each device writes `devices/<id>/history/<day>.json.gz` holding the merged state of that day. Round 1's full-state-per-file rule is kept per shard, not rewritten: a shard is the unit of merge, commit, publish, and ack. A day file is about 15 KB gzip per device (P5: 451 KB for 30 days). Only the shards that changed are uploaded, and a debounced cycle republishes today's file at most about once a minute. Old days are written once, and tombstone GC applies per shard.

**The window.** `expired` returns true for visits older than 90 days (Chromium's retention, fixed, not a setting). The engine applies `retain` to observed, applied, and every replica before the fold, so aging out is never read as a delete and never makes a tombstone. A device deletes its own files for wholly expired days. A first-join device with an empty local history pulls up to 90 shards and works newest-first.

**What "apply" means.** The profile "shows" native Helium history plus the corpus (`chrome-history.ts`), so `read` returns both. If it returned only native visits, the fold would read every remote visit's absence as a local delete.
- An add goes to the **corpus** (IndexedDB, indexed by time and day). Never `history.addUrl`, which would put thousands of visits stamped "today" into chrome://history, inflate visit counts, and need an echo ledger to stop them syncing back.
- A remove drops the corpus copy, or, if the visit is native here, deletes exactly that visit with `history.deleteRange` over a one-millisecond window. The adapter refuses if another url has a visit in that millisecond. Deletes propagate, because a page you removed must not stay searchable on your other devices. The mass-delete guard stops "Clear browsing data" from silently wiping the other devices. It blocks until the popup confirms.
- `applied` means "the corpus (and native history) shows `target`", which is true as soon as the IndexedDB transaction commits. One transaction per shard keeps a kill from leaving a half shard.

**What the user gets in default mode.** Honestly, this is a searchable archive of the other devices, not a merged history:
- `hs <text>` in the address bar and the History page find any visit from any device in the last 90 days, with real times and days.
- Opening a result makes Helium record a local visit, so the page then enters native autocomplete on its own.
- Not provided: those visits in chrome://history, native address-bar suggestions, or visited-link colouring. The API cannot write them without false timestamps.
- Reading local history is incremental. `history.search` over the window is O(urls), and `getVisits` runs only for urls whose `(lastVisit, count)` signature changed. A steady cycle is tens of milliseconds.

### File mode: the opt-in boundary

File mode is a history-only writer for the one thing the API cannot do, putting a visit in Helium's History database at its real time (P1: visit times survive only through the file path). Bookmarks never use it. The extension is complete for them, and the browser must be running to show them anyway. This shrinks round 1's file adapter to one table pair.

**On the extension side it is one decorator.** `withNativeHistory(history, link)` leaves `read` alone. `apply` runs the base (the corpus, immediate, searchable now), then stages the added visits with the host. It costs one line in `worker.ts` and no branch in the engine. It needs the optional `nativeMessaging` permission and the host installed, both explicit in setup, with a plain statement that the host writes Helium's History database while Helium is closed, with backups, against its README. Without the permission, or if the host vanishes, the decorator is absent or drops staging, and file mode never defers or fails a cycle.

**On the host side** (`file-mode/protocol.ts`) the host is a Node process Helium spawns through native messaging. Its two jobs never overlap in time:
1. While Helium runs, it accepts `stage` and writes only to its own state dir.
2. On EOF (Helium quit), it spawns a detached applier and exits. The applier waits until Helium is provably closed (round 1's SingletonLock check: host matches, pid dead or not the Helium binary), copies `History` to a backup, inserts every staged `(url, time)` with no existing row in one transaction, recomputes counts for touched urls, re-checks run state, and commits. Then it writes a receipt.

**Why nothing has to coordinate.** After the import, `chrome.history` returns the same content-hash ids the corpus already holds, so `read` sees one visit, and the corpus drops its copy. A lost receipt, a half-run import, a rerun, or a second device importing the same visits all converge the same way. The result is true history merge: chrome://history, native autocomplete, link colouring, real times. This is round 1's daemon, with the daemon deleted. The browser spawns the host, and the host exits when the browser does.

### Invariants the compiler holds

Probed (`Profile` missing a channel, `Settings` missing a type: both fail to compile):
- `Profile<Reg>` and `Settings.types` are keyed by the registry, so adding a data type is a compile error until its channel and its default exist.
- `Rpc` maps each message to its handler type, so `serve` cannot miss one and `call` cannot send a wrong payload.
- `WriteChannel.apply` is the only way the engine touches a profile, and `dryRun` is an engine option, so the extension has no read-only/write split to misuse.
- Brands (`DeviceId`, `ItemId`, `Hlc`, `ShardKey`, `StoreKey`) come only from parsers, as in round 1.
- External data is parsed in the same four places as round 1 (`parseKey`, `parseMeta`, `parseStateFile`, per-type `parseRecord`), plus `readSettings`.

### Interface depth

`Engine` is still two methods. Behind `sync` sit decode and version checks, rollback and clone detection, idle handling, HLC, merge, adoption, GC, expiry, sharding, mass-delete, publish ordering, the budget, and crash safety. `Scheduler` is one method, `request`. It hides durability, debounce, the lock, keep-alive, backoff, and the event cap. `HostLink` is two methods and `CorpusReader` two. `DataType` grew by two members, and both are irreducible per-type knowledge. Wire shapes stay private: the store format in `store-format.ts`, the host protocol in `file-mode/`, and chrome nodes in the adapters.

### Module map

```
runtime/worker.ts          listeners to scheduler.request; compose engine; omnibox       (the only entry)
runtime/scheduler.ts       counters, wake, Web Lock, keepAlive, budget, backoff
runtime/local-idb.ts       LocalState and Counters over IndexedDB
runtime/rpc.ts             Settings, Status, typed page<->worker RPC
runtime/chrome-io.ts       settings read, status write + badge, resume alarm
engine.ts                  the cycle, SyncReport, crash table
  crdt.ts  model.ts  registry.ts  types/{bookmarks,history}.ts   pure; copied from round 1 plus shard/expiry
  store-format.ts          keys, envelope, codec (CompressionStream), StateFile
  ports.ts                 Store, Profile/WriteChannel, LocalState, Budget
adapters/fsa-store.ts  adapters/webdav-store.ts          Store implementations
adapters/chrome-bookmarks.ts  adapters/chrome-history.ts  adapters/corpus.ts
file-mode/{protocol,host-link}.ts                          the opt-in boundary
ui/view-model.ts  manifest.ts
```

Each question lands in at most three files. "What if the worker dies here?" is `scheduler.ts` and the crash table in `engine.ts`. "Why is this visit here?" is `chrome-history.ts` and `corpus.ts`. "What does file mode touch?" is `host-link.ts` and `protocol.ts`.

## Synthesis decision

Left to the arena picker. This candidate's bets, for comparison:
- Reuse round 1's engine unchanged in kind. Concentrate the new design in the runtime layer and in history.
- Make the folder store the default and WebDAV the second adapter behind the port, instead of choosing one.
- Treat remote history as a searchable corpus, and file mode as a decorator that upgrades it.
- Shrink file mode to a history-only writer.

## Tradeoffs accepted

- We accept no sync while the browser is closed, in exchange for no daemon, no launchd, and no run-state detector. There is nothing to look at while Helium is closed, and the first cycle after launch catches up.
- We accept that remote history is not in chrome://history or native autocomplete by default, in exchange for never writing false timestamps or inflating visit counts. File mode removes the limit for those who opt in.
- We accept a 2-minute poll, in exchange for working with folders and servers that have no change events.
- We accept that a lapsed folder grant may need one click after a restart (unverified), in exchange for no account and no server. WebDAV is the prepared escape.
- We accept per-shard full state, so each device's day file carries every device's visits for that day (about 3x store bytes for three devices), in exchange for keeping round 1's acked GC and single-writer proof unchanged. The window caps it at 90 days.
- We accept that history deletes propagate and are applied to native history by `deleteRange`, in exchange for privacy parity with a real sync. The mass-delete guard asks first.
- We accept a derived id per local bookmark that changes if the DeviceId resets, in exchange for no stored map. Adoption absorbs the reset.
- We accept plaintext in the user's folder in v1, per the user's decision. The codec seam is intact. History makes this the sharper edge (see questions).
- A visit records no origin device. It would need an immutable `origin` register and a stability rule so file-mode imports do not flip it. The history page cannot filter by device in v1.

## Alternatives considered

- **Engine in an offscreen document or a pinned tab.** It would give a long-lived context and drop the scheduler. It does not fit: the offscreen API has no honest reason value for a sync loop, and a visible tab is a worse product than a counter. Hosting the engine anywhere but the worker also adds a second writer to coordinate. The worker is stateless anyway.
- **The native host as the engine (round 1's v2 insight).** Strongest runtime, but it makes install friction the default, which the user ruled out. It is kept as the history-only opt-in.
- **Write remote history with `history.addUrl`, with an echo ledger.** It gives native autocomplete. It also pollutes today's history with thousands of visits at the wrong time, changes ranking through visit counts, and needs a visitId ledger to stop echoing. Rejected as the default. This alternative is shallow: it exposes every one of those costs to the user.
- **Override `chrome://history` with `chrome_url_overrides`.** It puts remote history on the familiar page, but it is static in the manifest (no opt-in), replaces a core browser page, and is a CWS review risk. The History page is reachable from the popup and the omnibox instead.
- **History as per-url state (title, last visit).** 1.1 MB gzip (P5) and simpler, but it discards visit times and counts, so the corpus cannot show "when" and file mode cannot reconstruct visits.
- **`chrome.storage.sync`.** Expected to be local-only without a Google account (verify on Helium).
- **A hosted relay server as the default store.** Zero-click, but it would hold plaintext URLs with no encryption, and it would be our server to run.

## Implementation reconciliation

None yet.

## Open questions and risks

1. **Should history be on by default?** The recommendation is bookmarks on and history off, with a visible toggle at setup. With no encryption, plaintext URLs in a cloud folder are a larger exposure than bookmarks, and default-mode value is a searchable archive, not a merge. Your call.
2. **Does an FSA handle stay writable from the worker after a restart?** Needs an unlocked screen and a real restart. If not, is WebDAV the right default fallback, or an account-based store?
3. **Does a detached applier spawned from the native host survive Helium's shutdown?** Expected on macOS and Linux. Windows puts children in a job object. If not, apply falls back to the next launch before the window opens, which needs a launcher shim.
4. **Is propagating history deletes to native history acceptable?** The alternative is corpus-only deletes plus a per-device suppression set, which is more state.
5. **Quota constants.** `MAX_WRITE_OPERATIONS_PER_HOUR` and the sustained limit: verify they apply on Helium 154 and are not looser.
6. **Does the alarms minimum of 30 s hold on 154?** The design needs only that alarms wake a dead worker and that `delayInMinutes` is not rounded down to zero.
7. **Does the 20 s keep-alive ping reset the idle timer on this build?** If not, long cycles end by the budget, not by a kill, and the design still converges. The budget would just shrink to ~25 s.
8. **iCloud eviction** can make `get` return "not yet". `brctl download` is not available from an extension, so a placeholder means waiting for the OS to materialise it.
9. **Origin device on a visit** (see tradeoffs). Worth it for a history page, or later?

## Next implementation step

Build `scheduler.ts` and `local-idb.ts` with a fake `Wake`, a fake lock, and a kill-injecting `runCycle`. Assert that killing at every await converges to the same store bytes. This proves the MV3 claim before any adapter exists.
