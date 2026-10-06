# helium-sync, candidate 2: file-first

## Problem

Sync Helium profile data between a user's devices through a folder they already sync (iCloud Drive, Dropbox, Syncthing), with no server of ours. The merge model is settled by P3: each device writes only its own file, every item is a set of last-writer-wins registers stamped with a hybrid logical clock, and readers merge. What is not settled is how the engine touches the browser. This candidate takes the file-first direction: the adapter reads and writes profile files directly and writes only while Helium is closed. P1 fixes the constraints: a Bookmarks write while Helium runs is ignored and then clobbered; the SingletonLock symlink survives a kill, so "closed" means host matches, pid dead or not the Helium binary; History is readable while running by copying or `?immutable=1`, writable only when closed; the profile README forbids modifying files outside Helium APIs. The engine must also outlive this frontend (CLI now, extension UI and desktop app later) and this transport (folder now, S3/WebDAV/server later).

The user must never be the one who thinks about "is the browser closed". The design makes that the daemon's job and splits the sync into two halves with different preconditions: outbound (profile to store) runs any time because reading profile files while Helium runs is safe; inbound (store to profile) runs in the closed window. Reading is not modifying, so the outbound half honors the README; the inbound half cannot and says so.

## Usage (caller's view)

Install once per device. The folder is the only thing the user chooses.

```
$ helium-sync init ~/Library/Mobile\ Documents/com~apple~CloudDocs/helium-sync
Profile:  ~/Library/Application Support/net.imput.helium/Default (Helium 154, not running)
Device:   "Conan's MacBook" (a3f9…)
Pushed:   512 bookmarks, 8,140 history visits (90 days)
Daemon:   installed (launchd: net.imput.helium-sync), syncing on quit and on folder change
```

Second device, same folder. Adoption keeps the existing tree from duplicating.

```
$ helium-sync init /Volumes/Sync/helium-sync
Joined 1 device ("Conan's MacBook", last sync 2 min ago)
Adopted 498 bookmarks already in both trees; 14 remote bookmarks and 2 folders are new.
Helium is running: new items will land the next time it quits. Run `helium-sync open` to restart with them now.
```

Steady state is zero commands. The daemon pushes local edits a few seconds after Helium writes them, pulls remote state whenever the folder changes, and applies pending remote state to the profile in the next closed window, which includes the quit the user was going to do anyway. The two optional commands exist for the user who wants certainty:

```
$ helium-sync status
Store:     /Volumes/Sync/helium-sync (3 devices, 1 idle 41d)
Helium:    running (pid 4121)
Bookmarks: in sync with store; 3 remote changes waiting for Helium to quit
History:   pushed 12s ago; 211 remote visits waiting

$ helium-sync open https://example.com   # sync, apply, then launch Helium with the url
$ helium-sync sync                       # one pass now, apply if closed (works with no daemon)
$ helium-sync restore --list             # backups taken before every profile write
```

Call sites in other frontends. A desktop app embeds the engine; the extension UI (later) reaches the daemon over its control socket through the native-messaging host that P2 proved.

```ts
// desktop app: own frontend, own transport, same engine
import { Engine } from 'helium-sync/engine';
import { FolderStore } from 'helium-sync/store';
import { locateProfile } from 'helium-sync/profile';
import { openLocalState } from 'helium-sync/local';
import { registry } from 'helium-sync/registry';

const engine = new Engine({
  store: new FolderStore(settings.folder),      // later: new S3Store(bucket)
  profile: locateProfile(),
  local: await openLocalState(),
  types: registry,
});
engine.on('report', (r) => tray.render(r));     // SyncReport is the one event
await engine.sync();                            // applies to the profile only if Helium is closed

// extension UI (later): talks to the running daemon, never to files
const daemon = await connectControl(controlSocketPath());
const status = await daemon?.request({ cmd: 'status' });
```

Adding a data type is one `defineDataType` call and one registry entry; the engine, store layout, daemon, and CLI pick it up with no edits.

```ts
export const history = defineDataType<HistoryFields>({
  name: 'history',
  fieldKeys: ['url', 'title', 'visitTime', 'transition'],
  read: async (profile) => { /* copy History, open immutable, select 90 days */ },
  write: async (profile, target) => { /* insert missing urls/visits, closed window only */ },
});
export const registry = [bookmarks, history] as const satisfies readonly DataType<Fields>[];
```

## Shape

### Data structures

`Item<F>` is a record of registers, one per field, plus a `deleted` register. `DeviceState<F> = ReadonlyMap<ItemId, Item<F>>` is the unit a device writes to the store and the unit the merge consumes. `Snapshot<F> = ReadonlyMap<ItemId, F>` is what the browser shows: the same ids, bare values, no stamps. Every data type is defined by `F`, its field record, so merge, materialize, diff, encode, decode, and garbage collection are written once over `F extends Fields` and never know what a bookmark is (`model-the-domain`). `ItemId`, `DeviceId`, `Stamp` are branded strings; a `Stamp` is fixed-width `wall36.counter36.deviceId` so causal order is string order and the merge never parses it (`type-system-discipline`).

Store layout, zero shared files: `devices/<deviceId>/device.json` (name, platform, format version, last-sync stamp) and `devices/<deviceId>/<type>.json.gz` holding that device's full merged state. P3 showed any shared file loses writes on a dumb folder; per-device files had zero conflicts in 36 runs and survive a crash after write, so the store is per-actor state merged at read (`separate-before-serializing-shared-state`).

Local state, one file per type, written atomically: `own` (the state we last intended the store to hold), `baseline` (the snapshot the browser showed the last time we looked), `aliases` (local id to sync id until the first closed-window write rewrites guids), `pushedHash`. The baseline is the single source of truth for "what did the user change": a diff of the current snapshot against it is exactly the user's edits and nothing else. The view/base split in the prototype collapses into this one value because the file-first engine has two apply paths (now or later) and both end by setting baseline to what the browser file now contains (`single source of truth`).

### Data flow (`Engine.sync`, per type)

1. `store.list/read` all device files, parse at the boundary into `DeviceState<F>` (`wire.ts`), merge with `own` into `S`.
2. `type.read(profile, baseline)` while Helium may be running. Bookmarks keeps the baseline's fractional positions for unmoved nodes so reordering noise does not become edits.
3. First join: `type.adopt(snapshot, materialize(S))` yields aliases; the snapshot is remapped. Otherwise `stampChanges(own, baseline, snapshot, stamp)` folds user edits into `S` with one fresh HLC stamp.
4. Local commit: write `{own: S, baseline: snapshot, aliases}` atomically, then `store.write`. A crash between the two re-uploads identical bytes next run; a crash before the local commit re-derives the same diff. Both converge, nothing is stamped twice with a newer clock (`make-operations-idempotent`).
5. If `profile.openForWrite()` succeeds (Helium closed, lock re-checked before every rename, backup taken first), `type.write(target = materialize(S))`, then baseline becomes `target` and aliases clear. If Helium is running, the report carries `pending`, the daemon and `status` show it, and step 5 runs at the next transition to closed.

### Modules (short chains: CLI to profile write is three files)

| file | owns |
|---|---|
| `datatype.ts` | `Fields`, `Item`, `DeviceState`, `Snapshot`, branded ids, `DataType<F>`, `defineDataType` |
| `registry.ts` | the v1 list: `[bookmarks, history]`; the only file that changes when a type is added |
| `merge.ts` | pure: `mergeStates`, `materialize`, `stampChanges`, `remapIds`, `collectGarbage`, `Hlc` |
| `wire.ts` | the only module that knows the on-store JSON; encode/decode with validation |
| `store.ts` | `Store` interface (bytes in, bytes out, optional `watch`) and `FolderStore` |
| `profile.ts` | locate profile, `runState` (lock + pid + binary), `openForWrite` gate, backups |
| `local.ts` | per-device local state, atomic per-type files, config |
| `engine.ts` | `Engine.sync`, `SyncReport`; the one thing every frontend calls |
| `types/bookmarks.ts`, `types/history.ts` | the two v1 `DataType` entries |
| `daemon.ts` | run-state watcher, folder watcher, debounce, control socket, service install |
| `cli.ts` | `parseArgs` and six commands; talks to the daemon when one runs, else runs the engine inline |

Interface depth: the public surface is `Engine.sync()`, `Store` (four methods), `DataType<F>` (two required methods), and `ControlRequest`. Behind `sync()` sit the merge, HLC, adoption, orphan repair, atomic ordering, run-state gating, and backups. Callers never see stamps, registers, store paths, or lock files. The `Store` takes bytes so S3/WebDAV implementations are twenty lines each and never learn the schema (`boundary-discipline`). The daemon is a frontend like the CLI, not part of the engine, so a desktop app can replace it.

### Never thinking about "closed"

The daemon owns the question. It watches the profile's `SingletonLock` with a pid poll (the lock survives SIGKILL), the Bookmarks file for Chromium's atomic rewrites (debounced, triggers outbound), and the store folder (triggers pull; apply if closed). On the running-to-closed transition it waits for the pid to die and files to settle, then runs a full pass. `helium-sync open` is the belt for users who want remote changes before launch: pass, then exec Helium. The inbound write re-checks the lock before each rename and aborts the remaining types if Helium started mid-apply; each type's write is one atomic rename, so a half-applied pass is a fully-applied bookmarks file plus an unapplied history file, never a torn file.

### v1 data scope

- Bookmarks: yes. Guid-native, atomic JSON, checksum reproduced.
- History: yes, and it is the reason to pick file-first at all. P1 showed the file adapter preserves visit times and the extension path cannot. Visits are grow-only items with no mutable fields, so they ride the same register model (deleted is always false) and a 90-day horizon, which matches Chromium's own expiry, bounds the file to a few hundred KB gzipped. The write path checks `meta.version` against tested versions; unknown schema means read-only for that type plus a status warning, never a blind insert.
- Open tabs: no. SNSS is binary and unexplored, and "tabs that were open when Helium quit" is a session restore feature, not a sync feature. Revisit with an extension adapter.
- Extension list: no. Installs are blocked by the Secure Preferences MAC; the most we could do is report "device B has X you don't", which is a `status` line, not a data type. Defer until someone asks.
- Passwords: no. Keychain decrypt/re-encrypt is unverified, the README prohibition is most defensible here, and a merge bug loses credentials. Out of scope for every v1 direction.

## Synthesis decision

Filled in by arena.

## Tradeoffs accepted

- We accept violating the profile README for inbound writes in exchange for guid-native bookmarks and timestamp-preserving history. We narrow it: writes only when closed, only to Bookmarks and History, surgical edits that preserve unknown fields, a backup before every write and `restore` to undo.
- We accept that remote changes appear after the next Helium quit, not live, in exchange for never needing an extension installed or a native host. `status` and the daemon make the pending count visible so it is a known delay, not a mystery.
- We accept schema-drift risk on the History write path in exchange for history fidelity; the version gate turns drift into "read-only, warn" rather than corruption. Bookmarks JSON has been `version: 1` for a decade; we still parse defensively and write by editing the existing document.
- We accept a small startup race: Helium launched during an apply sees either the old or the new file, never a torn one, because each write is a rename and the gate re-checks the lock first.
- We accept clock skew flipping LWW (P3 finding) rather than add vector clocks.
- We accept Windows run-state detection as unverified; the module isolates it to one function.
- We accept full-state device files rewritten each sync (31 KB for 500 bookmarks, 2 MB for 50k) instead of append logs, until size says otherwise.

## Alternatives considered

- Launcher-only (no daemon): `helium-sync open` replaces the Helium icon. Smaller surface, but the user must remember to launch through us, and a quit without a launch pushes nothing. Lost on rubric 1.
- Shared snapshot plus 3-way merge: lost writes in 4 of 9 P3 scenarios on a dumb folder. Rejected by evidence.
- One generic "sync any JSON file" adapter: hides nothing, since every type's identity, adoption and repair rules differ; the `DataType<F>` contract keeps those per type while the merge stays generic.
- Watching with a Chromium `--remote-debugging-port` for live writes: requires launching Helium ourselves with a flag and exposes a debugging port; deferred to the extension direction where it belongs.

## Implementation reconciliation

Empty until Phase D.

## Open questions and risks

- iCloud Drive evicts files under "Optimize Mac Storage" and leaves `.name.icloud` placeholders. `FolderStore.read` can call `brctl download` and wait; is a 30 s wait acceptable, or should an evicted device file be skipped for that pass?
- Should `init` on a second device refuse to continue while Helium is running, so adoption and the first write happen together, or proceed and defer the write as sketched?
- A device idle more than 30 days is evicted (its files deleted by whoever notices) so tombstones can be collected. Is 30 days right for a laptop that goes in a drawer?
- Backups: keep last 10 per file, or last 7 days?
- Is launchd `WatchPaths` on the user data dir enough to start the daemon lazily, or should it run continuously (poll cost is one `kill -0` every 2 s while Helium runs)?

## Next implementation step

Implement `merge.ts` against the P3 scenario suite (port `scenarios.ts` to the `DeviceState<F>` types) so the generic merge is proven before any profile I/O exists.
