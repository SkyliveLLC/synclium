# helium-sync design

## Problem

Helium is a Chromium 154 fork with no Google sync. Users want their bookmarks, and later more profile data, to follow them across devices through a folder they already sync (iCloud Drive, Dropbox, Syncthing). There is no server. The CLI is the first of several frontends. The folder is the first of several transports. The file adapter is the first of two ways to reach the browser.

The prototypes fixed these constraints (see `grounding.md`):

- A shared store file with a 3-way merge lost writes in 4 of 9 scenarios on a dumb folder. Per-device files with per-field last-writer-wins registers and HLC stamps converged in every scenario with zero folder conflicts (P3).
- Helium ignores a `Bookmarks` write made while it runs, then overwrites it. The file adapter may write only while Helium is closed. `SingletonLock` survives a kill, so "closed" needs a host, pid, and binary check (P1).
- First-join adoption by content is required, or every bookmark duplicates (P3).
- The extension path has no guid, cannot set history visit times, and needs Developer mode to install (P2).
- Helium's profile README says storage "MUST not be ... modified except through Helium defined APIs". v1 writes `Bookmarks` anyway, only while Helium is closed. That is open question 1.

## Usage (caller's view)

### README quickstart

```sh
npm i -g helium-sync

# Every device runs the same command. The first one creates the store. Later ones join it.
$ helium-sync init ~/Library/Mobile\ Documents/com~apple~CloudDocs/helium-sync
Helium     ~/Library/Application Support/net.imput.helium/Default (running)
Device     conan-mbp (3f9c2a1e), first device in this folder
Bookmarks  published 512
Daemon     installed (launchd net.imput.helium-sync)

# Second device, wherever its copy of the folder lives
$ helium-sync init ~/Dropbox/helium-sync
Device     conan-mini (81d0f7b2), joining conan-mbp
Bookmarks  adopted 498, published 14, 37 waiting for Helium to quit
Daemon     installed
```

After `init` there is nothing to run. The daemon publishes your edits a few seconds after Helium saves them. It pulls when a peer's file changes. It applies remote changes when Helium quits.

```sh
$ helium-sync status
Store      ~/Dropbox/helium-sync (3 devices, conan-old idle 120 days)
Helium     running (pid 4121)
Bookmarks  published 2 min ago. 3 changes wait for Helium to quit.
             + url "RFC 9110" in "Specs"
             ~ folder "Reading"
             - url "old link"

$ helium-sync sync --dry-run      # one cycle, writes nothing, prints the plan
$ helium-sync restore --list      # backups taken before every profile write
$ helium-sync restore             # newest backup; refuses while Helium runs; propagates like an edit
$ helium-sync uninstall --forget  # removes the agent, local state, and this device's store files
```

When a profile read comes back empty, or loses more than half of 20 or more items, sync blocks that type and `status` says why. `helium-sync sync --force` lets it through.

### The daemon wires the engine

```ts
const paths = resolvePaths(platform, process.env);
const config = await loadConfig(paths); // null means "run helium-sync init <folder> first"
const helium = locateHelium(platform, os.homedir(), config.profileOverride);
const store = folderStore(config.store.path);
const engine = createEngine({
  registry, store, codec: gzipJson, clock: Date, platform, appVersion,
  profile: fileProfile({ paths: helium, backupDir: paths.backups, stateDir: paths.adapter }),
  local: localDir(paths, registry, { name: os.hostname() }),
});
startDaemon({ engine, helium, store, log });
```

### A desktop app, or a test

```ts
const report = await engine.sync({ dryRun: true });
for (const [type, outcome] of Object.entries(report.types)) {
  if (outcome.kind === 'deferred') tray.badge(type, outcome.pending.length);
}
```

Tests pass an in-memory `Store` and a fake `Profile` that opens any of the three session modes.

### Adding a data type

```ts
// types/history.ts
export const history: DataType<Visit> = { version: 1, parseRecord, adopt, normalize, label };

// registry.ts
export const registry = { bookmarks, history } as const satisfies Registry;
```

`Profile.channel` is keyed by the registry, so each adapter fails to compile until it returns a history channel or the type is removed.

## Shape

### Data structures

The register layer (`model.ts`) is generic and written once.

- `Reg<T>` is `[value, stamp]`. The higher HLC stamp wins.
- `Entry<R>` is one replicated item. It distributes over the record union, so a bookmark folder has no `url` register and a url bookmark always has one. `deleted` is a register too.
- `Replica<R>` maps `ItemId` to `Entry<R>`, tombstones included. It is what a device publishes.
- `Live<R>` maps `ItemId` to a plain record. It is what a profile shows and what `materialize` produces.

A data type supplies only domain knowledge (`DataType<R>`, four members). `parseRecord` validates untrusted field values. `adopt` matches local items to synced ones by content. `normalize` repairs a merged tree. `label` names an item for reports. Merge, stamping, GC, diff, and the wire format never learn what a bookmark is (per model-the-domain). Bookmarks is one file. `Location` holds parent and position in one register, so concurrent moves never split them. Positions are fractional strings. The three roots use Chromium's well-known guids, so they match on every device without adoption.

Device-private state (`ports.ts`) holds one `TypeLocal` per type:

- `own` is our replica as last committed. It is the only source of our own state. The store copy is never read back as input, so a cloud rollback of our file cannot lose our edits.
- `seq` and `pushedHash` order publishing (below).
- `applied` is the last `Live` we made the profile equal. It is null until the first join completes.
- `peers` keeps, per peer, the highest `seq` seen and the last good copy of its state file.

### Store layout

```
helium-sync/devices/<deviceId>/meta.json          DeviceMeta: name, platform, app version, lastSeen
helium-sync/devices/<deviceId>/bookmarks.json.gz  envelope header line + gzip(JSON StateFile)
```

Nothing is shared. Each device writes only under its own id (per separate-before-serializing-shared-state). "Creating" a store means the first device writes its meta. A state file holds the device's full merged state, not a delta, so any one live file carries everything its author has seen. The envelope header `{"magic":"helium-sync","formatVersion":1,"codec":"gzip-json"}` stays plaintext under every codec. End-to-end encryption later is a new codec plus a pairing flow, not a store migration.

### One cycle

`engine.ts` ends with the full cycle as pseudocode. The load-bearing rules:

1. **Commit, then publish.** The new `own` and `seq` are saved locally before the upload, and `pushedHash` after it. A crash between them re-uploads identical bytes and never re-stamps (per make-operations-idempotent).
2. **The fold rule.** A field gets a fresh stamp only when the observed value differs from `applied` and from the merged value. A half-applied or deferred apply therefore never re-stamps a remote value as a local edit.
3. **`applied` advances only on proof.** It moves when the profile already equals the target, or when `apply` returns `applied`. The file adapter returns `applied` only if Helium is still closed after the rename.
4. **Deferral needs no queue.** Pending work is always `diff(current, materialize(merged))`. A read-only session, or Helium starting mid-write, leaves `applied` where it was and the next cycle recomputes.
5. **Adoption is the one recovery path.** It covers first join, reinstall, and a crash mid-apply. Local items with unknown ids are matched by content against synced items the profile lacks. The engine hands the resulting aliases to the adapter through `bind`.
6. **Rollback detection.** A peer file with a lower `seq` than already seen is replaced by that peer's last good copy, because merging the stale file could resurrect items whose tombstones were collected. An unreadable file (partial upload, unknown codec) falls back to the last good copy too. Our own file with a higher `seq` than we wrote means another installation writes our id. That type blocks with `identity-clash`.
7. **Idle devices.** A device whose `meta.json` is older than 90 days is idle. Merge and GC skip it, so it no longer blocks tombstone collection. No device ever deletes another device's files. An idle device that comes back notices its own stale `lastSeen`, deletes its own old files, and rejoins under a new device id by adoption.
8. **Mass-delete guard.** An empty read, or more than half of 20 or more items gone, blocks the type until `--force`.

Tombstone GC uses `acked`. Each state file records, per author, the newest stamp of that author the device has merged. A tombstone goes once every live device has acked its author past its stamp. Every live device counts, read this cycle or not. The last good copy supplies a skipped peer's `acked`, and a peer with no good copy yet blocks GC.

### Ports

The engine imports `ports.ts` and the pure modules, never `node:*`.

- `Store` has `list`, `get`, `put`, `delete`, and an optional `watch`. Its contract is atomic `put` and nothing else. A folder, S3, WebDAV, or a server can meet it without knowing what a bookmark is.
- `Profile.open()` returns a `ProfileSession`, a discriminated union on `mode`. `offline` and `live` sessions return `WriteChannel`s. A `read-only` session returns `ReadChannel`s, which have no `apply`. Calling `apply` while Helium runs does not compile. `channelFor` in `engine.ts` is the only place the engine looks at mode, and its switch is exhaustive.
- `LocalState` holds `DeviceLocal`, an atomic `save`, a pid lock with stale takeover, and `reset` for the idle rejoin.
- `Codec` encodes a JSON body to bytes and back. v1 ships `gzipJson`.

### The write capability

`WritableProfile` comes only from `openForWrite`, which returns null while Helium runs. Its key is a module-private symbol, so no other module can build one. `replace` backs up first, checks run state, renames, and checks again. If Helium appeared after the rename, it may have loaded either file, so the result is `helium-started` and the engine reports deferred. It does not restore the backup, because that would be a second racy write. The file adapter's channels hold the capability. The engine sees only session mode (per type-system-discipline).

### Identity

A bookmark's `ItemId` is its Chromium guid. On first join the file adapter adopts by content. The engine passes the aliases (local guid to remote `ItemId`) to `bind`. The adapter stores them in its own alias table and resolves reads through it. The next offline write rewrites those guids in the file, because P1 showed Chromium loads whatever guid the file holds. The aliases then clear. The future live adapter keeps its own `ItemId` to chrome id map behind the same `bind`. Id mapping belongs to the adapter, never the engine.

### The daemon is a frontend

`init` installs a launchd or systemd user agent that runs `helium-sync daemon`. It watches three things. A Helium RUNNING to CLOSED transition triggers a sync that applies. A `Bookmarks` change triggers a debounced sync that publishes. A store change triggers a sync that pulls. A 15-minute poll covers unreliable cloud folder events. A manual `sync` and the daemon serialize on the local lock, so there is no control socket. The daemon decides when. The engine decides what.

### Invariants the compiler holds

- No `apply` on a read-only channel. No `WritableProfile` outside `file-profile.ts`. No `url` register on a folder `Entry`. No channel for a type outside the registry. A probe file asserting each of these failed to compile as expected.
- `DeviceId`, `ItemId`, `Hlc`, `StoreKey`, `Position`, `FolderPath`, and `BackupId` are branded. Brands come only from predicates and parsers, so the sketch has no casts.
- `channelFor` and `cli.main` switch exhaustively with a `never` default.
- External data is parsed in four places. `parseKey`, `parseMeta`, and `parseStateFile` guard the store, `parseBookmarksDoc` guards the profile, and `parseCommand` and `loadConfig` guard user input. Past them, types are trusted (per boundary-discipline).

### Interface depth

`Engine` has two methods, `sync` and `forget`. `status` is `sync({ dryRun: true })` plus the peer list. Behind `sync` sit decode and version checks, rollback and clone detection, idle handling, HLC, merge, adoption, GC, the mass-delete guard, publish ordering, deferral, and crash safety. `DataType` has four members, the irreducible per-type knowledge. `Store` has four methods. The wire format, Chromium JSON, and the alias table stay private to `store-format.ts`, `file-bookmarks.ts`, and the adapter's state dir.

### What v1 does not do

It writes no profile file except `Bookmarks`, and only while Helium is closed. It never writes another device's files. It does not encrypt. It has no control socket and no Windows agent. It syncs bookmarks only.

### v1 scope and the next registry entries

| type | v1 | next step |
|---|---|---|
| bookmarks | yes | Full fidelity through the file adapter. Merge proven in P3. |
| history | no | Second merge type, via the file adapter (only path that keeps visit times). Needs a size measurement and encryption first (questions 2 and 3). |
| open tabs | no | Publish-only type via the live adapter. Adds a `mode: 'publish'` variant to `DataType`. The engine gains one exhaustive case. |
| extension list | no | Publish-only via the live adapter. Read-only, since Secure Preferences blocks installs. |
| passwords | no | No API. Keychain route unverified, largest blast radius. |

### Module map

```
cli.ts                    argv to Command, wiring, prints reports
daemon.ts                 when to sync: run state, Bookmarks, store watchers; agent install
engine.ts                 the cycle, SyncReport, channelFor
  crdt.ts                 pure: tick, mergeReplicas, foldLocalChanges, materialize, ackedOf, collectGarbage, diffLive, massDelete
  model.ts                brands, Reg/Entry/Replica/Live, DataType contract
  registry.ts             { bookmarks }, TypeName, RecordOf
  types/bookmarks.ts      Bookmark, ROOTS, adopt, normalize, placeChildren
  store-format.ts         key layout, envelope, Codec, StateFile, DeviceMeta
  ports.ts                Store, Profile/ProfileSession/channels, LocalState, Clock
adapters/folder-store.ts  Store over a synced folder
adapters/file-profile.ts  run state, WritableProfile, backups, fileProfile()
adapters/file-bookmarks.ts Chromium Bookmarks JSON, alias table, checksum
adapters/local-dir.ts     paths, config, LocalState over state.json
```

Each question lands in at most three files. "When is it safe to write the profile?" is `file-profile.ts`. "How does a merge resolve?" is `crdt.ts` and `model.ts`. "What is in the folder?" is `store-format.ts`. "What order does a sync run in?" is `engine.ts` and `ports.ts`. "How does a bookmark reach Helium?" is `engine.ts`, `file-bookmarks.ts`, and `file-profile.ts`.

### The v2 path through the extension (documented, not sketched)

A `liveProfile` adapter wraps `fileProfile`. When the companion extension's native-messaging socket answers, `open()` returns a `live` session whose channels call `chrome.bookmarks`. Otherwise it delegates to the file adapter. Neither the engine nor the store changes. Once the extension exists, the native host Helium spawns is the daemon (candidate 1's insight). It lives exactly as long as the browser, which is when browser data changes. The launchd agent then becomes optional. The cost is the install friction in question 1.

## Synthesis decision

Candidate 3's port skeleton is the base, stripped of its vault, pairing, and observed-type machinery. Candidate 1 supplied the generic register layer, the fold rule, adoption as the single recovery path, and the well-known root guids. Candidate 2 supplied the write capability, the run-state check, the daemon as a frontend, `pushedHash`, `restore`, and `status`. Full record with sources and rejections is in `arena/SYNTHESIS.md`.

## Tradeoffs accepted

- We accept writing `Bookmarks` outside Helium's APIs, while closed and after a backup, in exchange for zero install and guid-native identity. Question 1 asks you to confirm.
- We accept that on a running browser without the extension, remote changes wait until Helium quits, in exchange for needing no extension. `status` shows exactly what waits.
- We accept a full-state file per device per type, about 31 KB gzip for 500 bookmarks and 2 MB for 50k, in exchange for a store with no shared file.
- We accept plaintext bookmarks in the user's cloud folder in v1, in exchange for shipping before the pairing flow exists. Question 2.
- We accept that clock skew can flip last-writer-wins between near-simultaneous edits (P3), and can shift idle detection, in exchange for no coordination.
- We accept that a device idle past 90 days loses deletes it made before going idle and may see items others deleted come back as new. In exchange, tombstones are collectable and no device deletes another's files.
- We expect implementation to need one internal cast when `crdt.ts` iterates fields of a distributive `Entry` union. The sketch has none today. If it appears, it stays inside that module.
- We accept that the node binary path is pinned in the agent unit. A node version switch breaks it until `init` runs again, and `status` says so.

## Alternatives considered

- **Data types own their profile I/O** (`read(ProfileDir)`, `write(WritableProfile)` on the type). Shallow for this goal. It binds every type to the file adapter, so the extension adapter would need a second I/O half per type. Session negotiation plus per-adapter channels hides that choice behind `Profile.open()`.
- **Extension-first.** It honors the README and syncs live. It loses guids and visit times, needs Developer mode, and cannot run while Helium is closed. It is kept as the v2 adapter.
- **Shared store file with a 3-way merge.** Smaller store, but P3 measured lost writes in 4 of 9 scenarios and folder conflicts in 20 of 36 runs.
- **Delete idle devices' files to free tombstones.** That makes one device write another's keys, which breaks the one-writer rule the whole store depends on. Excluding idle devices from merge and GC gets the same collection without it.
- **A control socket between CLI and daemon.** It would add a protocol and a stale-socket path to solve what a pid lock already solves.

## Implementation reconciliation

None yet.

## Open questions and risks

### Decisions for you

1. **Is writing `Bookmarks` while Helium is closed acceptable for v1?** Helium's profile README says storage "MUST not be ... modified except through Helium defined APIs". v1 writes that one file, only while Helium is closed, after a backup, with `restore` to undo. The recommendation is to accept for v1. You get zero install, guid-native identity, and sync that works while the browser is closed. The extension adapter ships later as the `live` mode. The alternative is extension-first. It honors the README, but you would enable Developer mode and load an unpacked extension on every device, bookmarks would lose their guids, and sync would only run while Helium is open.
2. **Should v1 encrypt at rest?** The recommendation is no for v1, yes before history. v1 ships the codec seam with `gzip-json`. End-to-end encryption (AES-GCM via `node:crypto`, an invite-token pairing flow) lands before history does. For you, `init` on the second and later devices becomes `invite` on an existing device plus `join <folder> <token>` on the new one. Existing stores need no migration, since each device re-seals its own files.
3. **Is history the right second type?** Only bookmarks were sized (500 nodes, about 31 KB gzip). History could be orders of magnitude larger and may not fit "full state in one file per device". It needs a measurement on a real profile before we commit to its storage shape.

### Risks

- **iCloud eviction.** "Optimize Mac Storage" replaces files with `.<name>.icloud` placeholders. `folderStore.get` requests a download and returns "not yet". Whether `brctl download` works unattended is unverified.
- **Linux and Windows are unverified.** User-data paths, `SingletonLock` semantics, and the binary check were observed on macOS only. Windows has no agent in v1.
- **The 90-day idle window.** A laptop in a drawer longer than that rejoins by adoption and loses its pre-gap deletes. Is 90 days right?
- **Clock skew.** A device with a fast clock wins near-simultaneous conflicts and looks fresher to idle detection. P3 accepted this. A skew warning in `status` is cheap if it bites.
- **The first join while Helium runs.** Adoption aliases persist in the adapter until the next offline write. If that write never happens (Helium always open), aliases live indefinitely. That is correct but untested beyond P1's single offline rewrite.
- **Guid retention.** P1 showed Chromium keeps a rewritten guid on load. It was checked once, not across a later in-browser save.

### Where this deviates from the synthesis brief

- **Idle devices are skipped by merge, not only by GC.** The brief said idle devices "just stop blocking tombstone GC". If their files were still merged, a tombstone collected after they went idle would meet their stale live copy of the item, and the item would come back. So merge skips them too. A returning idle device rejoins under a new device id and deletes its own old files, which keeps the rule that no device deletes another's files.

## Next implementation step

Implement `crdt.ts` and the pure half of `types/bookmarks.ts`, and port P3's `scenarios.ts` to drive the engine through an in-memory `Store` and a fake `Profile` that switches between `offline` and `read-only`, including crash-after-commit, Helium-started-after-rename, and first join while running.
