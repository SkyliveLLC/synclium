# helium-sync as an extension

Synthesized design, arena round 2. Sketch in `sketch/`. `npx -y -p typescript tsc -p design/sketch --noEmit` passes under `--strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Arena record in `arena-r2/SYNTHESIS.md`.

## Problem

helium-sync is a Chrome Web Store extension that syncs bookmarks and history between one person's Helium browsers, with no server of ours. Conan's round-2 decisions bind it. The extension is the product. Writing Helium's profile files directly is opt-in only. Everything in the folder is encrypted with a sync key the devices share (round 3, see "Every file is sealed with one sync key"). History is the second data type.

Four constraints make the shape non-obvious.

- **The store must be reachable from an extension.** v1 uses a folder the user already syncs (iCloud Drive, Dropbox, Syncthing) through the File System Access API. Whether Helium's picker accepts those folders, and whether the grant survives a restart in the service worker, is unverified. That is probe P7. The design must work, honestly degraded, on every P7 outcome.
- **The extension API is not the file adapter.** `chrome.bookmarks` exposes no guid, so sync keeps its own id map. `history.addUrl` cannot set a visit time (P2).
- **History is big.** 46k visits over 90 days is 1.9 MB gzip as one file per device (P5). It must be sharded, and a first join or a re-derive is about 17k `getVisits` calls.
- **The MV3 worker dies.** It can be terminated between any two awaits, and one event runs about 5 minutes at most. A 17k-call backfill or a 50k-bookmark first join cannot finish in one event.

Round 1's register layer, per-device files, fold rule, adoption, and Store contract are proven by P3. They carry over unchanged.

## Usage (caller's view)

### What the user does

**Device 1, about 40 seconds.** The user clicks "Add to Helium" on the Chrome Web Store. The install opens `app.html#setup` in a tab.

1. "Choose a folder you already sync: iCloud Drive, Dropbox, Syncthing." The user clicks [Choose folder], picks *iCloud Drive*, and clicks Allow in Chromium's "Let Helium Sync edit files?" prompt.
2. Setup shows "New sync folder" and the sync key it just minted, `HSK-7F3Q-…` with [Copy], and asks the user to save it in a password manager.
3. The device name is prefilled with "Mac", beside a checked "Sync history" box: "Bookmarks and the last 90 days of history are stored in this folder, encrypted with the sync key." The user clicks [Start].
4. Setup reports "Published 512 bookmarks. Catching up on history, newest days first."

**Device 2, the same clicks, plus the key.** The folder already holds a device, so the key step asks for its key: "1 device already syncs here. Enter the sync key from one of them." The user pastes it from their password manager, or copies it on device 1 under Advanced, [Show sync key]. Setup then previews the join before anything is written. "Joining conan-mbp. 498 bookmarks already match, 14 will be added here, 37 will be shared." Adoption by content prevents duplicates. Picking the parent folder or `Helium Sync/` itself both work.

**Steady state needs no action.** A bookmark edit publishes about 5 seconds after the last change. Peers' changes arrive within 5 minutes. The badge stays blank. The popup says "Synced 2 min ago with 1 other device" and offers [Sync now] and [Open].

**Peers' history** appears in the app page's History tab and behind the omnibox keyword `hs` (`hs rust async`). It is never added to Helium's own history.

**If the folder grant lapses after a restart,** the badge shows `!`. The popup says "Paused until you allow access to Helium Sync" with [Allow access]. One click in `app.html#allow`, plus Chromium's prompt, resumes sync. Edits made meanwhile are already stamped and committed locally, and they publish on the next cycle.

### The worker (`background.ts`)

```ts
const scheduler = createScheduler({
  intents: intents(), wake, now: Date.now,
  runCycle: async (budget, asks) => {
    const report = await (await engineFor('current')).sync({ budget, asks });   // rebuilt from IndexedDB every wake
    await publishReport(report);                                                 // chrome.storage.local + badge
    return report.kind === 'cycle' && !report.complete ? { kind: 'partial' } : { kind: 'complete' };
  },
});
chrome.bookmarks.onCreated.addListener(on('bookmarks'));          // every listener at top level
chrome.history.onVisitRemoved.addListener(on('history-removed')); // a durable ask, not an engine method
```

### The setup page

```ts
chooseButton.onclick = async () => {
  const chosen = await chooseFolder();                 // picker + edit prompt; saved as the candidate handle
  if (chosen.probe.kind === 'failed') return showFailure(chosen.probe.why);
  render(await ask({ kind: 'preview' }));              // JoinPreview, typed by the Protocol map
  startButton.onclick = () => ask({ kind: 'start', name: nameInput.value, historyOn: historyBox.checked });
};
```

### A test in Node, with no browser

```ts
const engine = createEngine({
  connect: async () => ({ access: 'ready', label: 'mem', store: memoryStore({ tearPuts: true }) }),
  bookmarks: fakeChannel(tree), local: memoryLocal(),
  history: { source: fakeVisits(p5Days), sink: memorySink(), local: memoryLogLocal() }, ...rest,
});
const r = await engine.sync({ budget: expireAfterUnits(3), asks: noAsks });
assert(r.kind === 'cycle' && !r.complete);   // rerun until complete; the store bytes converge
```

The engine imports no `chrome.*`, File System Access, or IndexedDB type, so P3's scenarios port directly. New scenarios are "worker killed at every await", "budget expires mid-backfill", "torn file under an old manifest", and "access lapses mid-cycle".

## Shape

### Module map

```
background.ts        listeners, engineFor(slot), report -> storage + badge, page protocol handler
scheduler.ts         durable intents, debounce + resume alarm, Web Lock, Budget, keepAlive
engine.ts            sync + forget, SyncReport, JoinPreview, fetch and publish phases   <- the deep module
  register-cycle.ts  syncRegisters, round 1's per-type body (bookmarks)
  log-cycle.ts       syncLog: scan, derive walk, pull, expire, echo rule (history)
  model.ts crdt.ts   round 1 register layer, plus RegisterType | LogType
  bookmarks.ts       round 1 Bookmark type
  history.ts         Visit as a LogType
  store-format.ts    layout, sealed manifest, envelope, Cipher, StateFile, LogShard
  sync-key.ts        SyncKey: mint, parse, format; cipherFor (HKDF, AES-256-GCM)
  snapshot-cycle.ts  syncSnapshot: publish own snapshot, keep peers' last good (extensions)
  peer-file.ts       fetch and open one peer file against its manifest entry
  reading-list.ts    ReadingItem as a RegisterType, ids from urls
  extensions.ts      ExtensionList as a SnapshotType, offers()
  profile-mode.ts    full profile mode's contract: Setting, SearchEngine, Address types, allowlist, host protocol
  ports.ts           Store, StoreConnection, StoreFailure, channels, LocalState, LogLocal, Asks, Budget
stores.ts            the saved StoreChoice -> connect, allow; the release StoreBackend
folder-store.ts      File System Access: choose, connect, allow, folderStore
webdav-store.ts      WebDAV over fetch: choose, connect, allow, webdavStore
chrome-bookmarks.ts  RegisterChannel<Bookmark>, chrome id map, planApply
chrome-history.ts    LogSource<Visit> over chrome.history, read-only
chrome-reading-list.ts  RegisterChannel<ReadingItem> over chrome.readingList
chrome-extensions.ts    SnapshotSource<ExtensionList> over chrome.management (optional permission)
chrome-profile.ts    the companion link over native messaging, and ProfileChannels: one read, staged applies
local.ts             IndexedDB schema, LocalState, LogLocal, history index, intents, store slots
ui.ts                Protocol, ask, StatusView, actionFor, badgeFor
companion/           opt-in file mode: link.ts (extension side), protocol.ts, host.ts
```

### The store is a folder, and the manifest is its commit point

```
Helium Sync/devices/<deviceId>/manifest.json                 presence, seq, and {rel: {hash, bytes}} for every file, sealed
Helium Sync/devices/<deviceId>/bookmarks.hsync               round 1 StateFile: envelope header + sealed gzip(JSON)
Helium Sync/devices/<deviceId>/history/<yyyy-mm-dd>.hsync    this device's own visits for one UTC day
```

Every key has one writer, so a dumb sync folder never sees a write-write conflict (per separate-before-serializing-shared-state).

A device writes its files first and its manifest last. A reader verifies every file against the hash in the writer's manifest before parsing. A torn write, an iCloud placeholder, or a half-synced Dropbox file therefore reads as "not yet", and the last good copy stands. Files are `.hsync` because the bytes are a plaintext header plus an encrypted body. Candidate 1 also suspected that Chromium's download protection fires on archive extensions when a File System Access writer closes. That reason is unverified.

`Store` has five methods. `get(key, known)` returns `ok`, `unchanged`, or `missing`, so an unchanged peer costs one metadata check and no read. `list` returns one directory's names and only discovers peers, because the manifest replaces recursive listing. `probe` writes, reads back, and removes a scratch file. Setup runs it before Start, and the status page runs it on demand. One `StoreFailure` union (`needs-permission`, `missing`, `unreachable`, `rejected`) covers `connect`, `probe`, and a `StoreError` thrown mid-cycle (per boundary-discipline). The popup turns each failure into one sentence and one button through an exhaustive `actionFor`.

`folder-store.ts` owns every File System Access hazard. `chooseFolder` runs in the app page inside a click. It finds or creates `Helium Sync/`, saves the handle in the `candidate` slot, and probes it. The worker promotes `candidate` to `current` on Start, under the cycle lock. Each slot has one writer, and backing out of setup changes nothing. `connectFolder` runs in the worker and never prompts. It returns a `StoreConnection`, and a `Store` exists only in the `ready` variant, so no code path can write without access (per type-system-discipline). The popup never touches File System Access, because the picker and the permission bubble take focus and close it.

### Every file is sealed with one sync key

Round 3, decided by Conan on 2026-10-06: a generated key rather than a passphrase, and encryption is mandatory, with no plaintext mode and no migration (nothing was deployed).

- **The key.** 256 random bits (`sync-key.ts`), shown as `HSK-` plus 13 groups of 4 Crockford base32 digits. The first device mints it; each other device pastes it. It lives in `DeviceLocal` beside the device name, so Start, Change folder, and an idle rejoin carry it like the rest of the setup, and Forget drops it. It never enters the folder. A random key cannot be guessed from a leaked folder the way a passphrase can.
- **The envelope.** Every file, manifests included, is a plaintext header line and then `iv ‖ AES-256-GCM(gzip(canonical JSON))`. The header names the codec, the format version (now 2), and a `keyId`, a 64-bit HKDF fingerprint of the key. The GCM associated data is the header plus the file's store key, so bytes open only at the path they were sealed for and under the header they were sealed with. A file copied into another device's folder, a forged header, or a torn write all read as "not yet".
- **Other keys.** A file whose header names another `keyId` reads as `other-key`, not as damage. A device under another key in the same folder is not a peer: its manifest is unreadable, so it is skipped with an `other-key` warning. Setup's preview turns "devices here, none under this key" into `needs-key`, and Start re-checks it under the cycle lock.
- **What still shows.** Device ids, which files exist (so which UTC days have history), their sizes, and when they change. Device names, the file list, and `lastSeen` are inside the sealed manifest.
- **Integrity.** Only key holders can write a file a peer accepts. Someone who can write the folder can still delete files or restore old ones; the existing seq and rollback checks handle the second.

The engine builds the cipher from `DeviceLocal.key` at the start of every cycle and from the pasted key in a preview, so `EngineDeps` no longer takes a codec.

### The P7 ladder picks the store

P7 is a 40-line unpacked extension. It picks iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs`) and Dropbox (`~/Library/CloudStorage/...`) in a tab. Then, across two Helium restarts, the worker reads the handle from IndexedDB, calls `queryPermission`, and writes a file.

| P7 finds | What the user sees | Store | Change to the design |
|---|---|---|---|
| **A.** The worker uses the handle, and the grant survives restarts | Nothing after setup | Folder | None |
| **B.** The grant lapses at restart, and the re-prompt offers "Allow on every visit" | One click, once, after the first restart | Folder | None |
| **C.** The grant lapses at every restart, with no persistent option | One click after every browser start | Folder if Conan accepts it (decision 2), else WebDAV | None, or `connectWebdav` replaces `connectFolder` |
| **D.** The worker cannot use the handle | As A, B, or C | Folder, with Store calls in an offscreen document | About 100 lines of offscreen Store proxy. No offscreen reason names file access, a CWS review risk. |
| **E.** The picker refuses iCloud Drive and Dropbox | Setup asks for a WebDAV account | WebDAV | Fill in `webdav-store.ts`, add `optional_host_permissions` |

Every rung keeps the engine, the store format, and the UI states unchanged. The popup renders the same `StatusView` variants on every rung. Only which `StoreFailure` appears, and how often, differs. Under WebDAV, `needs-permission` means a revoked host permission, and `unreachable` means offline.

A **local-only cycle** makes B and C tolerable. When the store is not `ready`, the engine still reads the profile, merges own state with each peer's last good copy, stamps and commits local edits, applies, and scans history into own days. It skips only fetching and publishing. When access returns, every own file whose plaintext hash differs from `published` is re-put. Without local-only cycles, an edit would be stamped when the folder came back and could wrongly win last-writer-wins against a peer's newer edit (per experience-first).

If the folder was moved or deleted, the popup says "Can't find Helium Sync" and offers [Choose folder]. Start then resets the device, which joins by adoption.

### A stateless worker with durable intents and a budget per wake

The worker holds no state. Each wake builds the engine fresh from IndexedDB, so "terminated mid-cycle" and "crashed mid-cycle" are the same event, and round 1's ordering already handles it.

**Triggers cannot be lost** (`scheduler.ts`, from candidate 3). IndexedDB holds `Intent { requested, completed, failures, asks }`. `request(trigger)` bumps `requested` in one transaction first. Then it arms a debounce timer for latency and a one-shot `resume` alarm as the durable backstop, because a timer dies with the worker and an alarm wakes it. Work is wanted while `requested > completed`. `completed` advances only to the `requested` value read before the cycle, so an edit during a cycle loops.

**User intents are durable counters.** `Asks { rederiveHistory, applyDeletions }` live in the same record. `history.onVisitRemoved` bumps `rederiveHistory`, and "Apply these deletions" bumps `applyDeletions`. The engine acts when an ask exceeds the count it last handled, and it saves the handled count in the same transaction as the work it started. Acting twice on one ask is impossible, and a crash before the save just acts again (per make-operations-idempotent and model-the-domain). This replaces candidate 1's `Engine.historyRemoved()`, so the engine surface is `sync` and `forget`.

**One drainer at a time.** Cycles run under the Web Lock `helium-sync` with `ifAvailable`. The browser releases a lock whose holder died, so there is no stale-lock code. The RPCs that touch engine state outside a drain (`start`, `preview`, `set-history`, `forget`) take the same lock in wait mode.

**A budget per wake.** The drain creates a 4-minute `Budget` and passes it into `sync`. The engine checks it between units of work, never inside one. A unit is the bookmark merge, one bookmark API call during apply, the incremental history scan, one derived day, or one pulled peer shard. Every unit commits on its own, so stopping loses nothing. A `partial` result re-arms `resume`, and the next event continues with a fresh budget. A 90-day backfill or a 50k-bookmark first join spans several wakes and shows "Catching up" meanwhile. `keepAlive` pings `chrome.runtime.getPlatformInfo()` every 20 seconds during a cycle.

Triggers are `onInstalled`, `onStartup`, a 5-minute `poll` alarm (re-created on every wake if missing), bookmark events (5-second debounce), `onImportEnded`, `onVisitRemoved`, and page messages. New visits need no trigger, because the poll scans them.

### Two models, one function each

`RegisterType<R>` is round 1's `DataType` with a `model: 'register'` tag. `LogType<E>` is new and has four members (`parseEvent`, `key`, `retentionDays`, `label`). Bookmarks are registers, because any device may edit an item. History is a log, because a visit is an immutable fact with one author.

The engine runs one function per model. `syncRegisters` in `register-cycle.ts` is round 1's per-type body. `syncLog` in `log-cycle.ts` is new. A third type, such as open tabs as a log, plugs into one of the two with one line in the engine and one dependency. There is no registry. With two types of different models, a registry would add mapped types and a dispatch switch and remove nothing (per laziness-protocol and minimize-reader-load).

Each cycle function returns the files it wants published as `Wanted { plain, body() }`. The publish phase seals a body only when its plaintext hash differs from what was published, puts the changed files, and puts the manifest last. A wanted set always lists every own file, touched this cycle or not. A file leaves the manifest only when its day expires or history is turned off, so a budget cut can never unpublish anything.

### Bookmarks keep an id map and apply on a budget

`chrome-bookmarks.ts` owns the `ChromeId` to `ItemId` map, as round 1 required of a live adapter. Roots map by `folderType` through a table that `satisfies` an exhaustive type over chrome's `FolderType`. A node with no map row gets `crypto.randomUUID()`, saved before `read` returns. `apply` runs the pure `planApply(current, target)`, checks the budget between API calls, and returns `applied`, `stopped`, or `interrupted`. `applied` moves only on `applied`, and the next wake recomputes the remaining diff from the tree, so nothing is queued. Adoption claims any node a killed apply created before its map row landed.

There is no write-rate machinery. The cross-judge believes the `chrome.bookmarks` quota constants candidate 3 designed around are deprecated and unenforced, so this is a risk to verify, not code to write.

### History is owner shards, a derive walk, and an index

Each device publishes only its own visits, one shard per UTC day, and readers take the union. A normal cycle re-puts only today's shard (about 20 KB gzip).

- **Capture is a scan.** Each cycle collects `[watermark - 60 s, now)` with `history.search` plus `getVisits` per url, keeps `isLocal` http(s) visits, and unions them into own days. A crash re-scans, and the event key dedupes.
- **Backfill and re-derive are one walk** (from candidate 2). `LogCursor.derive` names the next day and the oldest. Each unit makes one own day equal what Helium shows for that day, newest first, and persists the cursor. Joining starts the walk over 90 days. A `rederiveHistory` ask restarts it, and so does a weekly timer that catches deletes no event described. A local delete leaves the owner's shard when its day is re-derived, and peers replace that day whole. No tombstones are needed, because only the owner ever held the visit in a file.
- **The echo rule** (from candidate 2). Every peer event key this device hands its sink is recorded in `ingested`. Scan and derive drop local events whose key is already there, so a peer's visit that the companion wrote into this profile is never republished as this device's own. Keys are kept for the retention window, so the rule holds after the peer's shard is gone.
- **Pull.** For each live peer, newest day first, each shard whose manifest hash differs from the one applied is opened against that hash and handed to the sink. The sink replaces everything indexed for (peer, day). A day that left a peer's manifest, or a peer gone idle, is dropped from the index.
- **Retention is 90 days**, matching Chromium. An owner drops expired days from its manifest, then deletes the files, then forgets them locally.
- **Apply means the index.** The default sink is IndexedDB `peerVisits`, which the History tab and `hs` search. helium-sync never calls `history.addUrl`, which would stamp every remote visit "now".

### The reading list is a second register type, keyed by url

Round 3. `chrome.readingList` exists in Helium and is keyed by url (P8), so `ReadingItem`'s ItemId is `rl.` plus a sha256 prefix of the url Chromium stored. Every device derives the same id for the same page. The channel keeps no id map, `adopt` is the identity, and two devices adding one page before syncing make one entry with one title. `title` and `read` are last-writer-wins registers; removal is a tombstone like a bookmark's. `normalize` keeps one entry per url, because a forged peer file could name a url under a second id, and Chromium refuses a duplicate. The cycle is `syncRegisters` unchanged, run after bookmarks with the clock bookmarks committed. The mass-delete guard and the review page cover it with their own noun.

### Extensions are a snapshot: offered, never installed

Round 3. Extensions cannot install extensions (P8), so syncing them means showing each device what the others have. That is a third model, `SnapshotType`: each device publishes its own list whole (`extensions.hsync`), readers keep each live peer's last good copy, and nothing is merged or applied. `snapshot-cycle.ts` is the whole cycle.

`management` is an optional permission, granted from the Extensions page with one click. Until it is granted, the source reads null and nothing is published, so a device shares its list only once its user asks. The report carries live peers' lists; the page compares them with `management.getAll()` on the spot and lists what is missing, each with [Add] to its Chrome Web Store page (`installType: normal`). Unpacked and other installs are named but not linkable.

### Full profile mode: three register types behind a companion that writes only while Helium is closed

Round 3, decided by Conan on 2026-10-06: unprotected settings, custom search engines, and addresses; a single companion binary, macOS first; writes happen automatically after Helium quits. Protected settings, the default search engine, and cards stay out (P9: they need the keychain-bound hashes or keys, and a wrong write resets them with a banner or silently).

- **The contract** is `extension/src/profile-mode.ts`, imported by both sides: the three record types and register types, the settings allowlist, and the native messaging protocol (`hello`, `read`, `bind`, `stage`).
- **Settings** are items keyed by pref path, inside `SETTINGS_ALLOWLIST` only, which `normalize` enforces against peer files too. An absent pref is Chromium's default, so removing the item resets the pref. **Search engines** are custom `keywords` rows keyed by `sync_guid`, adopted by keyword and url. **Addresses** are `addresses` rows with their `address_type_tokens`, keyed by guid, adopted by non-empty tokens, one register for the whole address.
- **Staging.** The companion reads the files at any time: Preferences as JSON, Web Data through `?immutable=1`. It never writes while Helium runs. `apply` in the extension's channel stages each change with the value it replaces, and `read` overlays staged changes whose `before` still matches the file, so the extension's next read equals its target and nothing re-stamps. A helper process waits until Helium has quit (`SingletonLock` gone or its pid dead), backs up `Preferences` and `Web Data`, writes each change whose `before` still matches, and drops the rest: the user changed that value meanwhile, and their edit is folded as a local change on the next cycle.
- **Ids.** Settings ids are paths, the same everywhere. Engines and addresses keep their local guids in the profile; the companion keeps the local-to-synced alias map that `bind` fills, so adoption never rewrites a row's guid.
- **Which profile.** A native host is not told which profile launched it. The companion reads the user data dir from its parent process's command line (default `~/Library/Application Support/net.imput.helium`), lists profiles from Local State, and the extension stores the one the user picked (just one: picked automatically).
- **Off by default, per device.** Until the user grants the optional `nativeMessaging` permission, installs the companion, and turns the mode on in Advanced, the three channels are absent: the types report `off`, publish nothing, and apply nothing. Peers keep what they merged.
- **Web Data version.** Rows are read and written only when `meta.version` is in `WEB_DATA_VERSIONS` (154 today). Otherwise settings still sync and the page says rows wait for an update.
- **Implementation notes.** A channel's `read` may return null ("this type cannot be read now"); `syncRegisters` then reports `off` and keeps its state and published file, so an unsupported Web Data version never reads as deleting every row. The profile status (`off`, `unavailable`, `on` with pending count) lives in `Shown.profile`, built by the worker, because the engine cannot see permissions or the companion. `RegisterType.emptyReadIsSuspect` keeps the "empty read means a failed read" rule for bookmarks only; lists people empty on purpose rely on the fraction rule. The dev build holds its optional permissions up front so scripted e2e runs need no prompt. Verified on scratch Helium by `extension/e2e/profile-mode.mjs` (15/15).

### Local state has one writer per record

One IndexedDB database holds `DeviceLocal`, `Intent`, the two handle slots, the id map, own days, peer-day marks, peer visits, and ingested keys. Visit payloads stay out of `DeviceLocal`, so a cycle never rewrites megabytes. `chrome.storage.local` holds only the last `SyncReport` and the companion status. The popup renders from it and re-renders on `storage.onChanged`, which never wakes the worker.

| State | Writer | Readers |
|---|---|---|
| `DeviceLocal`, `Intent`, log state, id map, peer index | worker, under the cycle lock | worker |
| `folder:candidate` handle | app page | worker (preview, promote) |
| `folder:current` handle | worker (promote) | worker, app page (allow) |
| last `SyncReport` | worker | popup, app page |

Pages never run the engine and never write its state. They ask through a typed `Protocol` map, from which `UiMessage` and `UiReply<M>` derive. The worker's handler is an exhaustive switch (per separate-before-serializing-shared-state).

### Opt-in file mode is one sink decorator

File mode does one thing no extension API can. It puts peers' visits into Helium's own History database at their real times. It is recommended for v1.1, with the boundary fixed in v1.

- **Extension side.** `withCompanion(index, link)` decorates the history sink. `put` writes the index first, then stages the visits with the host. `drop` touches only the index, because the companion never deletes. `background.ts` picks the sink in one line, and the engine never knows file mode exists. Opting in grants the optional `nativeMessaging` permission inside a click and installs the companion download. The page says plainly that the companion writes Helium's History database while Helium is closed, with a backup, against Helium's README.
- **Host side.** Helium spawns the host through native messaging. While Helium runs, the host only stages visits into its own state dir. On stdin EOF it spawns a detached applier and exits. The applier waits until Helium is provably closed (round 1's SingletonLock host, pid, and binary check), backs up `History`, inserts staged visits that have no `(url, visit_time)` row at their real time in one transaction, re-checks run state, and commits. A rerun inserts nothing. There is no launchd or systemd agent, and file mode never writes Bookmarks.
- **The port stays open for the session.** EOF must mean "Helium quit", so the link holds its port instead of opening one per cycle. An open native port keeps the worker alive (P2), which is acceptable in an opt-in mode. A port that drops for another reason looks like EOF, and the applier then sees Helium running and waits, so a false close costs nothing.
- **Echoes.** Inserted visits come back through `chrome.history` with the peer's key (url plus integer µs time), and the echo rule drops them.

### Invariants the compiler holds

A probe file confirmed that each of these fails to compile when violated.

- A `Store` exists only in `StoreConnection`'s `ready` variant. `StoreStatus` derives from it with a distributive `Omit`.
- `engine.sync({ preview: true })` returns `JoinPreview`, and a cycle call returns `SyncReport`, through overloads.
- A `LogType` cannot stand in for a `RegisterType`.
- `StoreFailure` is closed, and `actionFor` switches over it with a `never` default, so a new failure needs a button.
- `UiMessage`, `UiReply`, and the handler derive from one `Protocol` map. `DEBOUNCE_MS` satisfies `Record<Trigger, number>`. `ROOT_BY_FOLDER_TYPE` is exhaustive over chrome's `FolderType`.
- `DeviceId`, `ItemId`, `ChromeId`, `Hlc`, `DayKey`, `EventKey`, `StoreKey`, and `RelName` are branded and minted only by predicates and parsers.

One rule is not in types. `chooseFolder` and `allowFolder` must run inside a click, and a misuse fails loudly with Chromium's `SecurityError`.

### Interface depth

`Engine` has two methods and hides access checks, manifest verification, local-only cycles, round 1's merge pipeline, the log model, budgets, asks, and crash ordering. `Scheduler` has one, `request`. `LogLocal` is the widest port at nine members, all persistence and no policy. Wire and storage shapes stay private to the module that owns them.

## Synthesis decision

Candidate 1 is the base. It gives the product shape: the folder through File System Access, owner-only history day shards, no `addUrl`, the History page and `hs`, the permission ladder, local-only cycles, `Store` only in `ready`, IndexedDB state, the id map in the bookmarks adapter, and the typed page protocol. Candidate 3 gives the runtime (durable intents, debounce plus `resume` alarm, the Web Lock drainer, the per-wake `Budget`, keepAlive, the stateless worker), the join preview, and the file-mode host shape. Candidate 2 gives the manifest as commit point, `get(key, known)`, typed `StoreFailure` plus `probe`, the day-at-a-time backfill, the echo rule, and the two-model data types. `arena-r2/SYNTHESIS.md` lists each graft, each rejection, and the cross-judge verdict.

## Tradeoffs accepted

- We accept a possible click after browser restarts (rungs B and C) in exchange for no account, no server, and no install beyond the Web Store.
- We accept that peers' history shows only in our History tab and `hs`, not in `chrome://history` or Helium's omnibox ranking. In exchange, Helium's own history never holds fake "now" visits.
- We accept plaintext bookmarks and history in the user's cloud folder in v1 (Conan's decision). Setup says so in one sentence.
- We accept that history is not a register replica. It is deliberate, because owner-authored immutable facts need neither merge nor tombstones.
- We accept that deriving a day at a time calls `getVisits` once per url per day it appears, more than one 90-day pass would. In exchange, every unit resumes and the newest days are searchable first.
- We accept a full re-derive, spread over wakes, after any history deletion, in exchange for exact delete propagation with no tombstones.
- We accept a persisted `ingested` key set in exchange for an echo rule that holds after peer shards are gone. Without the companion it never fires.

## Alternatives considered

- **History as a register replica.** Lost on size and fit. A full-state file per device is 1.1 to 1.9 MB rewritten each cycle (P5). Candidate 3's per-shard registers make every device republish everyone's visits, an N-fold bloat, and force tombstones onto data with one author.
- **Apply remote history with `history.addUrl`.** Every remote visit lands at "now". Even one call per url (candidate 2's hint sink) puts misdated rows in `chrome://history`. Out of v1.
- **A data-type registry with mapped `Profile` and `LocalState` types.** It hides the model dispatch behind generics but shows every reader `RecordOf`, `EventOf`, and per-model key unions. With two types, one function per model is shallower to read and no harder to extend.
- **WebDAV as the v1 default.** It needs no gesture and survives restarts. It fails "under a minute, no account" for most users, and with no encryption the server sees every URL. It stays the fallback behind the same port.
- **The engine in an offscreen document or the app page.** Sync would run only while a tab is open, or depend on an offscreen reason CWS may reject. It stays rung D.
- **The companion as the default store (candidate 1's rung E).** It would make the default path depend on a native install, against rubric 3. WebDAV keeps the default within extension APIs.

## Implementation reconciliation

Decisions accepted by Conan on 2026-10-06:

1. History sync is on by default, with the one-sentence unencrypted notice at setup.
2. Rung C is acceptable. If P7 finds the grant lapses at every restart, the folder stays the default and the user clicks once per browser start.
3. The file-mode companion ships in v1.1. v1 keeps only its boundary.

Unit 1 (engine core against in-memory ports) is built in `extension/src/` and supersedes `design/sketch/` for the modules it covers. Verified by the orchestrator: `npm run typecheck` exits 0, `npm test` passes 59 of 59. Accepted deviations, each found by a failing test:

- **GC pins referenced tombstones.** `RegisterType.references` was added, and `collectGarbage` keeps a tombstone that a live record still points at. Without it, P3 scenario 2 flipped a bookmark between two folders after its parent's tombstone was collected.
- **Adoption places new items among synced neighbours** (`AdoptInput.synced`). Two devices generated equal positions, which read as reorders and stamped false moves.
- **Fold rule refined.** An id present in the merged state but absent from `applied` keeps the merged values, so a killed apply is never stamped as a local move. A merged-deleted item takes no field stamps, so delete beats a concurrent edit.
- **Publish order is files, then the local save of `published`, then the manifest, then deletes.** The original order produced a false `identity-clash` after a crash between the manifest put and the save. Own files missing from our own manifest are re-put, which also repairs a cloud rollback of our files.
- **`RegisterLocal.acked` is persisted**, as `ackedOf` needs the previous value.
- **First join without guids.** A device that joins with a bookmark another device already deleted brings it back as a new item. P3 scenario 6 relied on guids the extension API lacks. A device that forgets and rejoins keeps its id map, so its own earlier deletes hold.
- **Scheduler dependencies** (`locks`, `timers`, `ping`) are injected so it runs in Node tests.

Unit 2 (IndexedDB state, chrome adapters, worker, pages, build) is built in `extension/`. Verified by the orchestrator: typecheck exits 0, `npm test` passes 69 of 69, `npm run build` produces a loadable `dist/`. Verified by the implementer in scratch Helium over CDP: a 13-check single-profile smoke and a 9-check two-profile run (`extension/e2e/`). Accepted deviations:

- **Two builds.** `npm run build` ships no store, so Start answers `not-ready` until `folder-store.ts` lands. `npm run build:dev` adds a single-browser dev store in `dist-dev/` under a different extension name. The release build fails if a dev-only module appears in it.
- **`BookmarkOp` carries the browser index**, since that is what `chrome.bookmarks` takes. Plans never move a node to a higher index within one folder.
- **Own history days split into a day list and a visit store**, so listing days does not load visit payloads.
- **`start` returns a result**, and the popup gains `error` and `outdated` states. Page messages carry a success-or-error envelope.
- **`background.ts` takes a `StoreBackend`** (connect, promote), which `folder-store.ts` will supply.
- **Observed on Helium 154.** `history.search({ maxResults: 0 })` means no limit.

Open from unit 2:

- Two bookmark roots of the same folder type (account plus local) sync only the first.
- `planApply` is quadratic on one very large folder.
- `chrome.runtime.reload()` disabled a command-line unpacked extension in testing. Dev tooling avoids it.

**P7 outcome is rung B** (see grounding.md). The first grant lapses after the first restart. The re-grant prompt offers "Allow on every visit", which then persists. The allow screen tells the user to choose it, so the click happens once.

Unit 3 (`folder-store.ts`, allow and change-folder UI) is built. Verified by the orchestrator: typecheck exits 0, 80 of 80 tests pass, the release build contains no dev-store and now syncs through `folderBackend`. Verified by the implementer in Helium Scratch with OPFS standing in for a picked folder (19 of 19 checks; `extension/e2e/folder-store.mjs`, `folder-rejoin.mjs`). Accepted deviations:

- **`chooseFolder` saves the candidate only after its probe passes**, so an unwritable folder never reaches Start.
- **Start deletes this device's old files in the folder it joins** before resetting, so a re-picked folder never lists the device's old identity as its own peer.
- **`devices/` is created with `Helium Sync/` and never deleted**, because it is how a second device recognises a store.
- **A file that changes during a read is "not yet"**, not a failure.
- **The allow screen tells the user to choose "Allow on every visit"** (P7 rung B).

Open from unit 3:

- Changing to a different folder leaves the old identity's files behind there. Peers in that folder see it idle out after 90 days.
- Setup's result line takes its bookmark count from the preview and can read "Published 0 bookmarks".

**End-to-end on 2026-10-06** (computer use, two Helium Scratch profiles, one iCloud Drive folder): device A set up and published 2 bookmarks. Device B previewed "Joining Device A. 0 bookmarks already match, 2 will be added here, 1 will be shared." and ended with all 3, no duplicates. B's new bookmark reached A after A's restart, the one-time "Allow on every visit" re-grant, and a cycle. A's next restart needed no prompt. Not proven: a cycle on browser startup before any extension page opens, because opening the popup itself requests a sync.

Unit 4 (`webdav-store.ts`, `stores.ts`) adds WebDAV as a second choice at setup, beside the folder. Setup saves a `StoreChoice` (a folder handle, or a URL with credentials) in the `store:candidate` slot, and `stores.ts` is the one switch over it, so the engine, the format, and the popup states are unchanged. Verified: typecheck exits 0, 91 of 91 tests pass against an in-memory server (`test/support/fake-dav.ts`), the Store and a two-device engine run pass against wsgidav, and a two-profile run in scratch Helium passes 10 of 10 checks (`extension/e2e/webdav.mjs`). Accepted deviations:

- **The store goes in a `Helium Sync/` collection under the typed address**, found or created by the folder rule, so every device types the same address.
- **Basic auth with `credentials: 'omit'`, over https only** (or http to loopback). The host permission is optional and narrowed to the server's origin at Connect. The password sits in IndexedDB in plaintext, and setup says so.
- **A version is the ETag**, sent back as If-None-Match. A server without ETags gets a content hash, so every get downloads but unchanged still holds.
- **A 404 below a missing root is `missing`**, never an empty store, as for a folder. Offline and 5xx are `unreachable`; 401, 403, and 507 are `rejected`.
- **Advanced's Change opens setup**, which offers both kinds. Existing installs read the old `folder:*` slots as not set up and choose again (pre-release, no migration).

Open from unit 4:

- A server whose ETag is mtime-in-seconds plus size (wsgidav, Apache) misses a same-size rewrite within one second, like a folder's lastModified.
- The Connect click's permission prompt, and Allow access after a revoked grant, are untested in the browser: CDP cannot click the bubble, so the e2e preinstalls the grant.

Open from unit 1:

- `StateFile.seq` and `writtenAt` look redundant with the manifest. Candidate for removal before the format freezes.
- If a synced folder rewrites a file without changing its lastModified, `get(key, known)` would never re-read that peer's manifest. Added to P7.
- Casts that remain: two brand mints in `store-format.ts` key builders, one in `history.ts`'s `visitKey`, and `viewToEntry` plus `recordOf` in `crdt.ts` for the distributive `Entry` type.

## Open questions and risks

### Decisions for Conan

Resolved on 2026-10-06. All three recommendations were accepted (see Implementation reconciliation).

1. **Should history be on by default, given no encryption?** (Superseded by round 3: the folder is now encrypted.) I recommend yes. Setup shows a checked "Sync history" box with one sentence beside it. "Bookmarks and the last 90 days of history are stored unencrypted in this folder." Unchecking it keeps sync bookmark-only, and the toggle stays in Advanced.
2. **If P7 lands on rung C (one click after each browser start), do we accept it or switch the default to WebDAV?** I recommend accepting C for v1. Local-only cycles lose nothing while paused, the click takes two seconds, and WebDAV costs most users an account. Revisit if early users report the click as friction.
3. **Is the companion (file mode) v1 or v1.1?** I recommend v1.1. The boundary is one sink decorator plus `companion/`, so it ships later with no engine change. v1 then needs no `nativeMessaging` justification in its first CWS review.

### Risks

- **P7 is built but unrun** (`prototypes/p7-fsa/`; it needs an unlocked screen). Every File System Access claim is unverified in Helium. That covers cloud folders in the picker, grant persistence, worker access, and `.crswap` behavior on `close()`.
- **Bookmark write rate limits.** Verify on Helium 154 whether `chrome.bookmarks` still enforces `MAX_WRITE_OPERATIONS_PER_HOUR` and the sustained limit. If it does, `apply` needs throttling, which the budget seam already accommodates.
- **Worker lifetime claims conflict.** Candidate 2 says fetch and in-flight API calls keep the worker alive. Candidate 3 says only `chrome.*` calls reset the idle timer. keepAlive pings a `chrome.*` API during every cycle, so the question stops mattering. If keepAlive fails on Helium, cycles end by budget, not by a kill, and still converge.
- **iCloud placeholders.** "Optimize Mac Storage" can leave a peer file as `.name.icloud`. It reads as "not yet", never as deleted, and status names the file. Whether iCloud re-downloads it unattended is unknown, so a peer could stall until Finder touches the folder.
- **CWS review.** The optional `nativeMessaging` permission and the `hs` omnibox keyword may need justification text. `history` plus `bookmarks` is a broad request for a new listing.
- **Clock skew.** Skew can flip last-writer-wins for bookmarks and shift idle detection, as round 1 accepted. For history it only shifts which day a visit lands in.
- **The 90-day idle window.** A device idle past 90 days rejoins by adoption under a new DeviceId. Bookmarks deleted elsewhere during its absence can come back, because their tombstones were collected.
- **Unmeasured history costs.** Whether `history.search({ maxResults: 0 })` means "no limit" on Helium, and what 17k `getVisits` calls cost, are unmeasured.
- **Copied profiles.** A copied Helium profile copies IndexedDB, so two machines share a DeviceId. The own-manifest seq check reports `identity-clash`, and the fix is "Forget this device" then setup.

## Next implementation step

Run P7 and pin the ladder rung before anyone writes `folder-store.ts`. The probe is built at `prototypes/p7-fsa/` and waits on an unlocked screen for a computer-use run. Then build `scheduler.ts` and the engine against in-memory ports, and assert that killing at every await and expiring the budget after every unit converge to the same store bytes.
