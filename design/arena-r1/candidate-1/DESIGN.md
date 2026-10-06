# helium-sync, candidate 1: extension-first

## Problem

Sync Helium profile data (bookmarks first) between one user's devices with no server, using a folder the user already syncs (iCloud Drive, Dropbox, Syncthing). The CLI is the first of several frontends and the folder is the first of several transports, so the engine cannot assume either.

Constraints from the prototypes (grounding.md):

- Helium's profile README says its storage must not be modified "except through Helium defined APIs". This design reads and writes browser data only through `chrome.*` in a companion MV3 extension, reached over native messaging (P2: proven topology).
- `chrome.bookmarks` has no guid, and `create` rejects an `id`. Sync identity must be ours. First-join adoption by content is required, or every bookmark duplicates (P3).
- `history.addUrl` rejects `visitTime`. `management` is read-only. There is no password API.
- A dumb sync folder loses writes to a shared file. Per-device files with per-field LWW registers and HLC stamps converged in every P3 scenario, with no folder conflicts.
- The native port keeps the MV3 worker alive (observed for 9 minutes or more). Nothing can reach the browser while Helium is closed.

## Usage (caller's view)

### README quickstart

```sh
npm i -g helium-sync

# First device. Same command on every later device.
helium-sync setup ~/Library/Mobile\ Documents/com~apple~CloudDocs/HeliumSync
#  ✓ store      …/HeliumSync (no devices yet: this is the first)
#  ✓ host       registered with Helium
#  … companion  not connected. Opening its store page in Helium: click "Add to Helium".
#  ✓ connected  conan-mbp (profile 3f9c2a1e)
#  ✓ synced     bookmarks: 512 published, 0 applied

# Second device
helium-sync setup ~/Library/Mobile\ Documents/com~apple~CloudDocs/HeliumSync
#  ✓ store      …/HeliumSync (1 device: conan-mbp)
#  ✓ connected  conan-mini (profile 81d0f7b2)
#  ✓ synced     bookmarks: joined (498 matched, 14 published, 37 applied)
```

After setup there is nothing to run. Sync happens while Helium is open: when the browser starts, about 1 s after any bookmark edit, when a peer's file changes, and every 60 s as a fallback. `helium-sync status` shows every profile on this machine, its peers and the last outcome. It still works while Helium is closed, using the local state files. `helium-sync sync` forces a run. `helium-sync uninstall [--forget]` reverses setup: it asks Helium to remove the extension (Helium shows its own confirmation), unregisters the host, and deletes local state. `--forget` also deletes this device's file from the store.

Before a store listing exists, the extension install step reads: open `chrome://extensions`, turn on Developer mode, click Load unpacked, and pick the directory `setup` printed and copied to the clipboard.

### Call site: the host wires the engine (host/daemon.ts)

```ts
const bridge = openBridge(process.stdin, process.stdout);
const { device } = await bridge.hello;
const engine = createEngine({
  self: device, label: config.label, types: registry,
  browser: bridge.browser,
  transport: openTransport(config.store),
  replicas: fileReplicaStore(paths),
});
bridge.onChanged(debounce(() => engine.sync(), 1_000));
const outcome = await engine.sync(); // { kind: 'synced', types: { bookmarks: { pushed, applied, failed } }, peers } | { kind: 'blocked', reason }
```

### Call site: a later frontend (desktop app, or the extension popup over its port)

```ts
for (const host of await connectAll(paths.run)) {
  const s = await host.send({ op: 'status' }); // HostStatus, typed per request
  render(s.label, s.last);
}
```

### Call site: adding a data type is one registry entry

```ts
// datatypes/openTabs.ts. Compiles against the sketch's types (checked while writing this design).
export const openTabs: PublishType<OpenTab, TabOps> = {
  name: 'openTabs', mode: 'publish', permissions: ['tabs'],
  browser: (api) => ({ ops: { list: async () => /* api.tabs.query({}) */ [] }, changes: [api.tabs.onUpdated, api.tabs.onRemoved] }),
  parse: (raw) => /* validate {kind:'tab', title, url, window, index} */ undefined,
  async observe(remote) { /* parse await remote.list(undefined) */ return new Map(); },
};
// datatypes/registry.ts
export const registry = { bookmarks, openTabs } as const satisfies { readonly [name: string]: AnyDataType };
```

From that entry, the extension dispatches `openTabs` calls, the generated manifest gains `tabs`, the blob format stores it (no version bump), and the engine syncs it. The cost of this direction is that a new type ships a new extension build, and Helium asks the user to approve the new permission.

### Call site: a later transport

```ts
export type TransportConfig =
  | { kind: 'folder'; path: FolderPath }
  | { kind: 's3'; bucket: string; prefix: string; credentialsRef: string }; // + one `case` in openTransport
```

## Shape

### Data structures

- **`Entry<R>`** (engine/model.ts) is one synced item. Each mutable field is a `Reg<T> = [value, Stamp]`, and `deleted` is a register too. `Entry` distributes over the record union, so a bookmark folder has no `url` register and a url always has one. Parent and position share one `Location` register, so concurrent moves never split a node's parent from its order.
- **`DeviceBlob`**, one per device, is the device's full merged state for every type, plus `label` and `writtenAt`. A device writes only its own blob. Because each blob holds the full state, a corrupt or missing peer file loses nothing: its contributions also live in every other blob.
- **`ReplicaState`**, one per device and local only, holds the HLC clock, `lastWrittenAt`, and per type `{ ids: SyncId→LocalId, view: Live<R> }`. `view` is the last state written into the browser, and the local diff is taken against it. The reverse id map is derived when needed and never stored.
- **`SyncId`** is ours. Bookmark roots use Chromium's well-known root guids, so a future file-based adapter would agree with us. **`LocalId`** is the browser's id and is never written to the store.

The dominant access patterns run on these structures as they are. "What changed here?" is `observed` vs `view`, both `Map<SyncId, R>`. "What does everyone agree on?" is a per-register max over the blobs. "Which browser node is this?" is `ids`. Folder child order is built once per run in `realize`.

### Flow of one run (engine.ts, single-flight)

`load state → readAll + decode blobs → tick HLC → per type: mergeReplicas → observe browser → foldLocalChanges → GC → materialize/normalize → write own blob if changed or heartbeat due → realize in browser → save state`.

Publish comes before apply, and the view is saved last. Crash walk:

| Crash after | Next run |
|---|---|
| decode or observe | Nothing was written. The run starts over. |
| writeOwn | The view is old, but the browser still matches it, so there is no diff. Merge and realize proceed. |
| part of realize | Created nodes have no id mapping. `observe` adopts them onto the merged state by content, so there are no duplicates. Moved, renamed and removed nodes already show merged values. `foldLocalChanges` stamps a field only when the observed value differs from both the view and the merged value, so the retry stamps nothing. |

Adoption is the single recovery path for first join, a crash mid-realize, and an extension reinstall (new DeviceId, same bookmarks). It is required for first join anyway, so recovery adds no new mechanism.

### Load-bearing decisions

1. **The native host is the daemon.** Helium spawns it when the extension connects, and it exits when the port closes. The browser's data only changes while the browser runs, so the daemon runs exactly then. There is no launchd unit, no login item, and no polling while Helium is closed. Steady state needs zero commands.
2. **The engine runs in the host. The extension is a dumb driver.** Merge bugs get fixed through npm, not through store review. The extension changes only when a type's chrome calls or permissions change. It holds no sync state except its DeviceId.
3. **A registry entry owns both halves** (per encode-lessons-in-structure). `browser(api)` runs in the extension. `observe`, `normalize` and `realize` run in the host. The bridge dispatches by name, and the manifest permissions are derived from the registry. The halves cannot drift because they are one object in one file.
4. **Each device writes one file, and the store has no other files** (per separate-before-serializing-shared-state). No shared index, no lock, no store manifest. `Transport.writeOwn(self, …)` is the only write.
5. **Local changes are found by snapshot diff. Change events only trigger runs.** A missed event, a worker restart or the host's own writes cannot corrupt state. They cost at most one extra no-op run.
6. **Validation happens at three boundaries** (per boundary-discipline): `decodeDeviceBlob` (store bytes), `parseLocalTree` and other `Remote` results typed `unknown` (bridge), and `parseCommand`/`parseFolder`/`loadConfig` (user input). Inside these boundaries, branded types are trusted.

### Invariants in types

Branded `DeviceId`, `SyncId`, `LocalId`, `Stamp`, `Position`, `Url`, `FolderPath`, and `HeliumDataDir`. `Entry` cannot hold a `url` register for a folder. `Remote<F>` returns `unknown`, so host code cannot skip parsing browser output. `DataType` is a `merge | publish` union, so a publish type cannot be realized into a browser. `Transport` has no way to write another device's blob. `openTransport` has no default branch, so a new `TransportConfig` kind fails to compile until it has a case. `ControlResponse[R['op']]` types each frontend call end to end. The only cast is in the `ROOTS` constants.

### Interface depth

- `Engine` has two methods, `sync` and `forget`. Behind them: decode and version checks, clone detection, eviction, HLC, merge, GC, adoption, write suppression, ordered browser writes, and crash safety.
- `Transport` has four blob methods. A folder, an S3 bucket or a server can implement it without knowing what a bookmark is.
- The control protocol has four requests. Frontends never see the engine, the bridge or the blob format.
- `DataType` is the widest interface: 6 members for merge types, 5 for publish types. That is the irreducible per-type knowledge: what a record is, how to read and write it in Helium, and what invariants survive a merge.

### What it deliberately does not do

It never reads or writes Helium's profile files. The only file it adds under Helium's directory is `NativeMessagingHosts/dev.helium_sync.host.json`, which is Chromium's registration point for native hosts. It does not encrypt (v1). It does not sync the mobile root, which `getTree` does not expose when empty. It does not carry `dateAdded`. It has no shared store files, no locks, and no background process while Helium is closed.

## v1 data scope

- **Bookmarks: yes.** Full read and write through `chrome.bookmarks`, and the merge model is proven on them.
- **History: no.** Through this API, a write lands every imported visit at "now", which corrupts history order on every device. Volume is also large, and plaintext history in iCloud is a privacy step users should opt into. Later, a `publish` entry could make other devices' history searchable without writing it into Helium.
- **Open tabs: no, but next.** `chrome.tabs` is live and complete, and the entry is about 20 lines (shown above). It needs a viewer to be worth having (the popup or the desktop app). A CLI tab listing is not good enough to ship first.
- **Extension list: no.** It is read-only, and installs are blocked. The only feature would be "missing on this device", which can be a `publish` entry later.
- **Passwords: no, in any direction, until there is end-to-end encryption.** No extension API exists. The file route means decrypting with the keychain, which breaks Helium's rule and would put secrets in a consumer cloud folder.

Bookmarks are the only data with two-way fidelity through Helium's APIs. That is why the shape carries a `publish` mode even though v1 has only a merge type: every realistic second type is publish-only.

## Where extension-first hurts

- **Install friction.** Before a store listing: Developer mode, Load unpacked, and Helium's developer-mode warning. Whether an unpacked install survives restarts for real users was not observed. A store listing means review latency for every extension change. Whether Helium installs from the Chrome Web Store for typical users is unverified.
- **No guid.** We keep `SyncId↔LocalId` per device and recover by content matching. When a folder has twin siblings (same title and URL), adoption pairs them by order. A wrong pairing is harmless because their content is equal.
- **Lost timestamps.** Remotely created bookmarks get the sync time as `dateAdded`, so sorting by date added drifts. History stays out of two-way sync for the same reason.
- **Sync only while Helium runs.** A closed device neither publishes nor applies. Its edits are still in the browser, and the next launch's diff picks them up. A device that stays closed for 90 days or more is evicted and later rejoins by adoption.
- **Moving parts.** A shim pins the Node binary path, so an nvm switch breaks the host until `setup` is rerun (`status` says so). Windows registers native hosts in the registry, and the key for Helium is unverified. First join of a 50k-bookmark tree takes about 50k sequential bridge round trips, roughly a minute.
- **Every profile with the extension joins the store.** Installing the extension is the opt-in.

## Synthesis decision

Not applicable. This is candidate 1 of the arena (extension-first). The arena picker fills this in.

## Tradeoffs accepted

- We accept that sync runs only while Helium runs, in exchange for no background agent and strict use of Helium's APIs.
- We accept extension install friction and store-review latency for browser-side changes, in exchange for never touching Helium's storage directly.
- We accept a full-state rewrite of our own file per change, in exchange for no shared mutable file. That is about 31 KB gzip for 500 bookmarks and about 2 MB for 50k.
- We accept a heartbeat rewrite every 24 h even when nothing changed, in exchange for eviction that works without a shared registry.
- We accept that clock skew can flip last-writer-wins between near-simultaneous edits (P3 3b), in exchange for no coordination.
- We accept sequential per-op bridge calls, in exchange for a stateless extension and per-op error handling. Batching can live inside `bridge/native.ts` later without an interface change.
- We accept that method syntax in `DataType` relies on TypeScript's parameter bivariance to fit heterogeneous entries into one registry type without `any`. This looks like an oversight but is deliberate. The engine never passes one entry's values to another entry.

## Alternatives considered

- **Engine in the extension, host as a file proxy.** This has one fewer process with logic in it, and HTTP transports would need no host. It lost because every engine fix would wait on store review, the folder transport still needs the host, the 1 MB host-to-extension message cap forces chunked blob reads, and `status` would need the browser running. The interface is no smaller, and the slow-to-ship part grows.
- **P2 topology as-is: CLI or launchd daemon → socket → host → extension.** The CLI-side daemon would need a login item, yet it still cannot reach the browser while Helium is closed. The host process already has the right lifetime, so a second daemon hides nothing and adds an install surface.
- **Direct file adapter (P1).** It has native guids, full history fidelity, and works while Helium is closed. It writes Helium's storage outside its APIs and only with the browser closed. That is outside this direction's premise. Each registry entry's browser half is shaped by the chrome API, so a file adapter would need its own observe and realize per type, not just a different `BrowserLink`.
- **Shared store file with 3-way merge.** P3 measured lost writes or non-convergence in 4 of 9 scenarios, and folder conflicts in 20 of 36 runs.

## Implementation reconciliation

Empty until implementation starts.

## Open questions and risks

- Does Helium install from the Chrome Web Store for typical users? If not, is a self-hosted CRX acceptable, or does v1 ship unpacked-only?
- Does a Load-unpacked install persist across Helium restarts when installed through the button, not `--load-extension`?
- Should v1 store bookmarks in plaintext in a consumer cloud folder? Passphrase encryption is a codec-only change now and a format migration later.
- Should every profile with the extension sync, or should a profile opt in explicitly?
- Is ignoring the mobile root acceptable? Nothing in Helium populates it today.
- Do iCloud `.icloud` placeholders need an explicit download request on read? `brctl download` behavior is unverified.
- Is a 90-day eviction window right? A laptop left in a drawer longer than that rejoins by adoption, and that device's deletes from before the gap can be lost.

## Next implementation step

Implement `engine/crdt.ts` and `storeFormat.ts`, and port P3's `scenarios.ts` to drive them through a fake `BrowserLink` and an in-memory `Transport`. Make crash-after-write, crash-mid-realize and join-with-own-tree pass before writing any extension code.
