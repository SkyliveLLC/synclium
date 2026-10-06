# Module map

```
engine/            core; imports nothing outside engine/; no node:* and no chrome.* values
  model.ts         brands, Reg/Entry/Replica/Live, DataType contract (merge | publish)
  crdt.ts          pure merge: HLC tick, mergeReplicas, foldLocalChanges, materialize, GC, write/evict policy
  engine.ts        ports (BrowserLink, Transport, ReplicaStore) + createEngine().sync()
  storeFormat.ts   PRIVATE blob codec (gzip JSON, versioned)
datatypes/         imports engine/model.ts only
  bookmarks.ts     the v1 registry entry: records, parse, chrome half, observe/normalize/realize
  registry.ts      { bookmarks } + derived extension permissions
transports/
  folder.ts        TransportConfig union + folder Transport (Node fs)
bridge/
  native.ts        native-messaging framing + PRIVATE extension<->host messages -> BrowserLink
extension/         bundled separately (tsc/esbuild dev-dep), loaded into Helium
  worker.ts        MV3 worker: DeviceId, native port, dispatch into registry browser halves
  manifest.ts      build-time manifest: pinned key, permissions derived from the registry
host/
  daemon.ts        the native host Helium spawns = the sync daemon: wiring, triggers, control server
  local.ts         paths, config, file-backed ReplicaStore
control/
  protocol.ts      frontend API over one socket per device: status | sync | reload-config | uninstall
cli/
  main.ts          setup | status | sync | uninstall, plus the native-host entry
  install.ts       host shim + native-host manifest + extension delivery
```

Tracing one sync touches three files: `engine/engine.ts` (order), `datatypes/bookmarks.ts` (what a
bookmark is and how it reaches the browser), `bridge/native.ts` (how a call crosses into Helium).

Process picture:

```
Helium ── MV3 worker (extension/worker.ts) ══ native port (stdio) ══ host (host/daemon.ts + engine)
                                                                       │          │
                                              CLI / desktop app ── unix socket    └── Transport ── sync folder
                                              extension popup ──── same port, `control` frames (later)
```

The sketch type-checks under `tsc --strict` with `@types/chrome` and `@types/node`.
