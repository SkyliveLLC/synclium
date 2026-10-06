# Architect arena synthesis

Three candidates designed helium-sync from the same grounding. Candidate 1 went extension-first. Candidate 2 went file-first. Candidate 3 put one engine over ports, with file and extension adapters behind one `Profile`. The synthesized package is `design/DESIGN.md` plus `design/sketch/`.

## Cross-judge verdict

The cross-judge (fable) scored candidate 1 at 25, candidate 2 at 22, and candidate 3 at 22. It recommended "candidate 3 stripped". Its reason was that only candidate 3's `Profile.open()` returning a `ProfileSession` lets the v1 file adapter and a later extension adapter plug into one engine without engine changes. It raised one nit. Candidate 3 modelled `apply` as an optional method, so nothing tied its presence to the session mode.

## The orchestrator's initial disagreement

The orchestrator first leaned toward candidate 2 and then conceded. Candidate 2's `DataType.read(ProfileDir)` and `write(WritableProfile)` put profile I/O on the data type. That binds every data type to the file adapter, so the extension adapter would need a second I/O half per type. Candidate 3's session negotiation keeps that choice inside the adapters.

## Base

Candidate 3's port skeleton, stripped. The engine sees `Store`, `Profile` and `ProfileSession`, `LocalState`, and `Clock`. `ProfileSession` is now a discriminated union. An `offline` or `live` session returns write channels. A `read-only` session returns read channels with no `apply`. This fixes the judge's nit at compile time, and a probe file confirmed that calling `apply` on a read-only channel fails to compile.

Kept from candidate 3:

- `Store` port. Bytes only, one writer per key, `list`, `get`, `put`, `delete`, optional `watch`.
- Session modes, with the union fix above.
- `applied` advances only after apply provably succeeded.
- Deferral without a queue. Pending work is `diff(current, materialize(merged))`.
- Per-device `seq` in each state file for rollback detection.
- A last good copy of each peer file. During synthesis this turned out to be load-bearing for GC (see refinements).
- The `SuspiciousChange` mass-delete guard, now `massDelete` in `crdt.ts` and `Blocked { kind: 'mass-delete' }`.
- Idle eviction that never deletes another device's files.

Stripped from candidate 3, each because v1 does not need it:

- `vault.ts`, `SecretStore`, invites, X25519 keys, key epochs, the recovery key. A `Codec` seam replaces them. State files are an envelope header `{magic, formatVersion, codec: 'gzip-json'}` plus a body. Encryption later is a new codec plus a pairing flow. It is open question 2 in DESIGN.md.
- `Engine.others()` and `ObservedType`. Publish-only types are named as next registry entries, not sketched.
- The history sharding reservation in the key layout (`<type>/<shard>`).
- `Engine.invite` and `Engine.revoke`, which only forwarded to the vault.
- `SyncEvent.phase`. The report is the one output.
- The live adapter sketch. It is documented in DESIGN.md as the v2 path.

## Grafts

| part | source | where it landed |
|---|---|---|
| Generic register layer, `Reg<T>`, `Entry<R>` distributing over the record union | candidate 1 | `model.ts` |
| `mergeReplicas`, `foldLocalChanges`, `collectGarbage`, `materialize` written once | candidate 1 | `crdt.ts` |
| Fold rule that stamps only when observed differs from both applied and merged | candidate 1 (its finding against its own `realize`) | `crdt.ts` `foldLocalChanges` |
| Adoption by content as the one recovery path (first join, reinstall, crash mid-apply) | candidate 1 | `DataType.adopt`, engine cycle |
| Chromium's well-known root guids | candidate 1 | `types/bookmarks.ts` `ROOTS` |
| `normalize(live, dead)` with cycle breaking and orphan re-homing | candidate 1 | `DataType.normalize` |
| Clone detection (own file ahead of local state) | candidate 1, re-expressed with `seq` | `Blocked { kind: 'identity-clash' }` |
| Heartbeat rewrite of the presence file | candidate 1 | `Policy.heartbeatHours`, `meta.json` |
| "The native host is the daemon once the extension exists" | candidate 1 | DESIGN.md v2 path, not sketched |
| `WritableProfile` capability, only from `openForWrite`, lock re-check around the rename, backup first | candidate 2 | `adapters/file-profile.ts`, unforgeable via a module-private symbol |
| Run-state check (lock symlink host, pid alive, pid is the Helium binary) | candidate 2, from P1 | `runState` |
| Daemon as a frontend with a RUNNING and CLOSED state machine, launchd or systemd agent from `init` | candidate 2 | `daemon.ts` |
| `pushedHash` of plaintext to skip unchanged publishes, local commit before upload | candidate 2 | `TypeLocal.pushedHash`, engine cycle |
| `restore` from backups, `status` | candidate 2 | `cli.ts`, `file-profile.ts` |
| Edit the existing Bookmarks document, keep unknown fields, recompute the checksum | candidate 2 | `adapters/file-bookmarks.ts` |
| Store layout `devices/<id>/meta.json` and `devices/<id>/<type>.json.gz` | candidate 2 | `store-format.ts` |

## Rejected

From candidate 1:

- Extension-first as the v1 direction. It honors the README but needs Developer mode, loses guids and visit times, and cannot sync while Helium is closed. It stays as the v2 adapter.
- `BrowserLink`, `Facet`, `Remote`, and the registry-generated manifest. They exist to cross native messaging, which v1 does not do.
- The control protocol over a per-device socket. v1 serialises the CLI and the daemon on a pid lock.

From candidate 2:

- `DataType.read` and `write` taking profile handles. This was the reason candidate 2 lost the base.
- History in v1. Only bookmarks were sized. History is open question 3.
- `helium-sync open` (sync, then launch Helium). The daemon already applies on quit.
- Deleting idle devices' files after 30 days. That makes one device write another's keys.
- `aliases` in the engine's per-type state. Id mapping moved to the adapter behind `ReadChannel.bind`.
- `stampChanges` comparing against the baseline only. It re-stamps remote values after a deferred apply. Candidate 1's fold rule replaces it.

From candidate 3, beyond the strip list:

- `LocalState.get(name): unknown`. Replaced by a typed `DeviceLocal` with per-type `TypeLocal`, parsed through the registry.
- Restoring the backup when Helium starts mid-write. That restore is a second racy write. The adapter reports `helium-started`, the engine defers, and the next cycle sees which file Helium loaded.

## Refinements made during synthesis

- **Idle devices are skipped by merge as well as GC.** Taken literally, the brief left their files in the merge. A tombstone collected after a device went idle would then meet that device's stale live copy and the item would return. A device that comes back after the window deletes its own old files and rejoins under a new device id by adoption. This is the one place the package deviates from the brief. It is recorded in DESIGN.md under open questions.
- **The last good copy feeds GC.** The first draft of the cycle dropped an unreadable peer from the GC quorum, which could collect a tombstone that peer never saw. The last good copy now supplies that peer's `acked`. A live peer with no good copy yet blocks GC.
- **Our own state is never read back from the store.** `TypeLocal.own` is the source. A cloud rollback of our own file therefore cannot erase stamps no peer has merged yet.
- **`status` is `sync({ dryRun: true })`.** There is one code path for "what would happen".
