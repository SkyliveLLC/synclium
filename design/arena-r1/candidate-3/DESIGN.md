# helium-sync: candidate 3 (one engine, three ports, ship the file adapter first)

## Problem

Sync Helium profile data between a user's devices through a folder they already sync (iCloud, Dropbox, Syncthing), with no server. Later frontends (extension UI, desktop app) and transports (S3, WebDAV, hosted server) must not require an engine change. Constraints from the prototypes:

- Helium writes its own bookmarks file and ignores or clobbers outside writes while it runs. A file adapter may write only when the browser is closed.
- Extension adapter: live, but chrome.bookmarks exposes no guid, history timestamps cannot be written, and install friction is high (Developer mode plus Load unpacked).
- The merge that won in p3: per-device state files (each device writes only its own), per-item LWW registers with HLC stamps, delete beats edit, content adoption on first join. A shared file with 3-way merge lost writes in 4 of 9 scenarios.
- The folder is a third party's disk. It must see ciphertext only, and must not be able to forge, swap, or silently roll back data.

My shape: neither extension-first nor file-first. The engine is a pure sync cycle over four ports. File and extension adapters are two implementations of one `Profile` port, picked per run by what is possible at that moment. v1 ships the file adapter alone, because it works for every user with no install. The extension adapter lands later as a drop-in.

## Usage (caller's view)

```
# Laptop A
helium-sync init ~/Dropbox/helium          # creates the vault, prints a recovery key once
helium-sync sync                           # publishes bookmarks; applies remote ones if Helium is closed
helium-sync invite                         # prints: hsync1.K3Q9X2MB.7T4G-N0VH-...   (valid 15 min)

# Laptop B (its Dropbox folder lives somewhere else)
helium-sync join ~/Dropbox/helium hsync1.K3Q9X2MB.7T4G-...
helium-sync sync --dry-run                 # shows the merge plan; first sync adopts by content, no duplicates
helium-sync sync
helium-sync watch                          # sync on folder change, bookmark change, and Helium exit
```

When Helium is running and no extension is connected, `sync` still publishes local changes. It prints `deferred: 12 changes, close Helium to apply them` and `watch` applies them on exit. Nothing is queued: pending work is always recomputed.

Library call site (desktop app, tests, or a future S3 build):

```ts
const engine = createEngine({
  registry, vault: await openVault({ store, secrets, clock }),
  store: folderStore(dir),            // swap: s3Store(...), webdavStore(...)
  profile: fileProfile({ userDataDir, profile: "Default", backupDir }),   // swap: liveProfile({ socketPath, fallback })
  state, clock,
});
const report = await engine.sync();   // plain JSON: mode, per-type outcome, devices, warnings
```

Extension UI call site: the extension sends `sync`, `status`, `invite`, `revoke` over native messaging to the host process. The host owns an `Engine` and implements `EngineApi`. Everything crossing that boundary is JSON.

Adding a data type (the whole change):

```ts
// registry in index.ts
export const registry = defineRegistry({ bookmarks, extensions });
```

plus a new file implementing `MergedType` or `ObservedType` (`types/extensions.ts` is a 15-line worked example) and a channel in each adapter that supports it.

## Shape

**Data structures first.**

- `MergedType<Id, Local, State, Change>` (registry.ts) is the unit of extension.
  - `Local` is the profile's content in domain terms.
  - `State` is the replicated form each device publishes.
  - `merge` is a commutative, associative, idempotent function over `State[]`.
  - `observe` folds local edits into merged state. `materialize` turns state back into `Local`. `diff` and `describe` drive apply and reports. `gc` drops acked tombstones.
- `ObservedType` is the other half of the design space: data each device publishes only about itself and others only read (open tabs, extension list). There is no merge, no apply, and no conflict. The one-writer-per-key rule is the whole algorithm. Modelling this separately keeps tabs and extensions out of a merge abstraction they would distort (per model-the-domain).
- `Registry` is a plain object. `LocalOf`, `ChangeOf` and `MergedIds` are derived from it, so `Profile.channel("bookmarks")` is typed `Channel<BookmarkTree, BookmarkChange>` with no casts, and a new entry type-checks through every adapter (per type-system-discipline). Method-syntax members make this work without `any`.
- Bookmarks `State` is p3's winner: a record per `ItemId` holding LWW registers for title, url, `where` (parent plus fractional string position) and `deleted`, each stamped with an HLC string. Branded `ItemId`, `Hlc`, `StoreKey` and `DeviceId` stop the id spaces mixing.

**Data flow.** The sync cycle is written as comments at the bottom of `engine.ts`. The load-bearing choices:

- `applied` (the last `Local` we made the profile equal to) is device-private state. It advances only after the profile provably equals it.
- The published bytes are a pure function of (remote files, current profile, `applied`). Crash anywhere and rerun: same result (per make-operations-idempotent).
- Deferral needs no queue. Pending work is `diff(current, materialize(merged))`. A read-only session, or a browser that starts mid-write, just leaves `applied` where it was.
- Each device publishes its full merged state in its own files. Devices never write the same key (per separate-before-serializing-shared-state). The folder only ever sees whole-file replacement by a single owner.
- A remote file that fails authentication (partial upload, conflicted copy, Syncthing tmp) is ignored and the last good copy is used. A lower `seq` than already seen is treated as a cloud rollback and ignored with a warning.

**Four ports (ports.ts).** The engine imports nothing else.

- `Store`: list, get, put, delete, optional watch. The contract is deliberately weak: atomic put and nothing else. S3, WebDAV and a server can all meet it. Bytes are opaque.
- `Profile` and `ProfileSession`: `open()` decides the mode once per cycle (`live`, `offline` or `read-only`) and returns channels. A missing `apply` means "cannot write this run". The engine never asks "extension or file?". `liveProfile` wraps `fileProfile` as its fallback, so the hybrid is composition, not a branch.
- `LocalState` (device-private: applied views, HLC, seen seqs, aliases, last-good copies, backups, a lock) and `SecretStore` (vault key, device key).

**Interface depth.** Callers see `createEngine`, `sync`, `status`, `others`, `invite`, `revoke`, `watch`, plus JSON reports. Hidden behind that:

- crypto and key custody
- store key layout and strict key parsing
- merge, HLC, GC and eviction
- rollback detection
- the running-browser check
- backups and apply-verify
- crash safety

`Vault` exposes `seal` and `open` but never the key. Wire types (Chromium JSON, native-messaging frames, envelope bytes) stay inside `adapters/` and `envelope.ts`.

**Encryption at rest.**

- One 256-bit vault key, generated on `init`, never in the folder in plaintext. It lives in `SecretStore` (a 0600 file by default, the macOS `security` CLI as an option). That is the same trust level as the browser profile itself.
- Every blob is `gzip(json)` sealed with AES-256-GCM from `node:crypto`. The per-file key is HKDF(vaultKey, random salt). AAD binds vaultId, epoch and the store key, so the cloud cannot move a blob between paths, replay it into another vault, or flip the epoch.
- Rollback is caught by the per-device `seq`. Truncation or tamper fails authentication. The folder still learns metadata: device count, which types, sizes, timing. Accepted.
- The vault key is epoched. Revocation means rotating: key epoch n+1 is sealed to the X25519 key of each remaining device. The wire format and epoch field ship in v1, and the `revoke` command can follow in v1.1.
- No dependencies: `node:crypto`, `node:zlib`.

**Pairing.**

- `invite` writes `invites/<id>` = vault key sealed under HKDF of a fresh 128-bit secret, and prints `hsync1.<vaultId>.<secret>`. The user carries the token to the new device (typed, pasted or QR). `join` derives the invite id from the token, fetches and decrypts it, generates its device id and X25519 key, and writes its own meta.
- The token is high entropy, so there is no PAKE and no short-code SAS and no dependency. The cost is a ~26-character secret instead of six digits.
- Any device deletes the invite once the joiner's meta appears. The folder never held the secret, so a lingering ciphertext is useless.
- `recoveryKey` (the vault key in base32) is the escape hatch for losing every device.
- The roster is the union of `devices/*/meta`. A device idle for more than N days stops blocking tombstone GC but is not deleted.

**Scope: which data types in v1.**

| type | v1? | argument |
|---|---|---|
| bookmarks | yes | Full fidelity on both adapters, small, merge model proven in p3. |
| extension list | after v1; the registry proof | `ObservedType`, read-only (installs are blocked by Secure Preferences MACs). Useful as a "missing here" report. It is the first entry added to prove the registry, but it is not worth shipping before bookmarks are solid. |
| open tabs | later, extension-only | Live and ephemeral, so `ObservedType` plus a send-tab action. Needs the extension adapter. |
| history | not v1 | It is a mergeable grow-only set, but it breaks v1's storage shape. Millions of rows do not fit "full state in one file per device", so it needs sharded or segmented files. Write fidelity needs the file adapter and a closed browser, because the extension loses visit timestamps. It is also the most sensitive data. The layout already reserves `devices/<dev>/<type>/<shard>` so sharding is not a migration. |
| passwords | no | Needs keychain decrypt and re-encrypt (unverified). The blast radius is the largest and the cloud is third-party. Even E2E, it deserves its own key and its own design. |

**Mass-delete guard.** `observe` may throw `SuspiciousChange` (empty read, or more than 50% of 20 or more items gone), for example when the wrong profile was read or the file was caught mid-write. The engine publishes nothing for that type until `--force`.

**Backups and blast radius.** The only profile file ever written is `Bookmarks`, only when Helium is closed. Every replacement is preceded by a timestamped backup in our own state dir, and followed by a lock re-check with restore on failure. `--dry-run` writes nothing.

## Synthesis decision

Not filled in: orchestrator step. Parts I would graft into a different base: the `ProfileSession` mode negotiation (removes engine branching), the `ObservedType`/`MergedType` split, the sealed-invite pairing with an epoched key, and applied-view deferral with no queue. If another candidate has a stronger store-key layout or a simpler HLC, I would take that.

## Tradeoffs accepted

- We accept a 26-character pairing token in exchange for zero dependencies and no interactive PAKE. A desktop app can render it as a QR.
- We accept per-device full-state files in exchange for conflict-free dumb folders. Bookmark-scale cost is ~31KB gzip per device. History needs sharding, which the key layout reserves.
- We accept that a revoked device can still read data written before rotation, in exchange for a simple symmetric vault key. Rotation is the only revocation.
- We accept symmetric trust: every device with the vault key can write any key. Per-device signatures would add attribution only. The cloud holds no key, so it cannot forge, and a compromised device already has the key.
- We accept that on a running browser without the extension, remote changes wait until Helium closes. The extension adapter exists to remove that wait, not to make sync possible.
- We accept HLC LWW clock-skew flips (grounding, p3).
- We accept that `applied`, aliases and the key live outside the folder, so losing the state dir means re-joining. Re-join is cheap because adoption by content prevents duplicates.
- Mixing file and extension adapters on one device requires an id alias table. It is the ugliest part of the design, contained in the bookmarks type and `live-profile.ts` (see risks).

## Alternatives considered

- **Extension-first.** The engine lives in the extension and the native host is a pipe. Its interface is shallow on the browser side (live and typed) but leaks installation, MV3 worker lifetime and the missing guid into every use. It cannot run when Helium is closed, which is exactly when you want to pull new bookmarks. Kept as an adapter instead.
- **File-only, single engine, no ports.** Simplest v1, but the second frontend and transport would force a rewrite. The ports cost four interfaces. Rejected because the stated roadmap is certain.
- **Shared snapshot + 3-way merge (p3 variant A).** Smaller store, loses writes under cloud-sync races. Rejected on prototype evidence.
- **Password-derived vault key (no invite).** Simple pairing, but the key is only as strong as the passphrase and the folder is an offline-attack target. Rejected.
- **Server-mediated pairing (SPAKE2 via relay).** Needs a server, which contradicts the premise.

## Implementation reconciliation

None yet.

## Open questions and risks

- Guid identity across adapters: nodes the extension creates get Chromium-minted guids, so the alias table is required. Is a v1 that only has the file adapter allowed to omit the alias machinery entirely (guid is the `ItemId`) and add it with `live-profile`?
- Does Chromium keep the guid when we rewrite the Bookmarks file offline? Observed yes (p1). Does it keep it across a later in-browser save? Presumably, but only checked once.
- iCloud evicts files to placeholders. Is a `brctl download` shell-out acceptable, or should the folder adapter only report "not yet"?
- Linux and Windows user-data paths and the running-browser check (SingletonLock semantics differ) are unverified.
- Is a 15-minute invite TTL, enforced only by clients, a sufficient promise, given the token is the real secret?
- Should the SecretStore default to the macOS Keychain rather than a 0600 file, given the vault key protects data the OS keychain would otherwise protect?

## Next implementation step

Implement `types/bookmarks.ts` (merge, observe with adoption, materialize) and port the p3 scenarios as its unit tests, since it is pure and the riskiest logic.
