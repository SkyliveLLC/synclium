# Arena round 2 synthesis

Frame: `frame.md`. Output: `../DESIGN.md` and `../sketch/`. The sketch passes `npx -y -p typescript tsc -p design/sketch --noEmit` under `--strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.

## Cross-judge verdict

A fable cross-judge scored candidate 1 at 24, candidate 3 at 22, and candidate 2 at 21 on the six-criterion rubric, and recommended candidate 1 as the base. It flagged three faults in candidate 1. `Engine.historyRemoved()` leaks a chrome event into the engine surface. A 17k-call history re-derive or a 50k-bookmark first join may never finish inside one worker event. The launchd agent and mirror protocol are heavier than file mode needs. The orchestrator accepted the recommendation and chose the grafts below.

## Base

Candidate 1. It kept the product shape closest to Conan's round-2 decisions:

- a folder the user already syncs, reached through File System Access
- owner-only history day shards, never `history.addUrl`
- peer history searchable in an extension History page and the `hs` omnibox keyword
- the permission ladder A to E, and local-only cycles when the store is not ready
- `Store` only in the `ready` connection variant
- IndexedDB local state, the chrome id map owned by the bookmarks adapter, and a typed page protocol

## Grafts

| Graft | Source | Lands in |
|---|---|---|
| Durable `requested`/`completed` counters, debounce timer plus one-shot `resume` alarm, Web Lock drainer, keepAlive, `partial` re-arms `resume` | Candidate 3 | `scheduler.ts` |
| A 4-minute `Budget` passed into `sync`, checked between units of work | Candidate 3 | `ports.ts`, `engine.ts`, `log-cycle.ts`, `chrome-bookmarks.ts` |
| The worker holds no state; each wake rebuilds the engine from IndexedDB | Candidate 3 | `background.ts` (`engineFor`) |
| `joinPreview`, a dry run in setup before Start | Candidate 3 | `engine.ts` (`JoinPreview`, `sync({ preview: true })`), `ui.ts` |
| File-mode host shape: stage while Helium runs, detached applier on stdin EOF, provable-close check, backup, insert at real `visit_time`, re-check, commit; extension side is one sink decorator; never writes Bookmarks | Candidate 3 | `companion/` |
| The manifest as commit point; readers verify files against its hashes | Candidate 2 | `store-format.ts`, `engine.ts` |
| `Store.get(key, known)` returning `ok`, `unchanged`, or `missing` | Candidate 2 | `ports.ts`, `folder-store.ts` |
| Typed `StoreFailure` and `StoreError`, plus `probe` for setup and status | Candidate 2 | `ports.ts`, `folder-store.ts`, `ui.ts` (`actionFor`) |
| History backfill one day per unit, newest first, cursor persisted | Candidate 2 | `log-cycle.ts` (`LogCursor.derive`) |
| The echo rule as a generic log rule | Candidate 2 | `log-cycle.ts`, `LogLocal.ingested` |
| Two-model data types, `RegisterType` and `LogType` | Candidate 2 | `model.ts`, one function per model |
| `ChangeSummary` (counts plus a sample) in reports | Candidate 3 | `engine.ts` |

## Fixes to candidate 1

- `Engine.historyRemoved()` is gone. `onVisitRemoved` is a scheduler trigger that bumps a durable `rederiveHistory` ask. The engine surface is `sync` and `forget`.
- The launchd agent and its mirror protocol are gone, replaced by candidate 3's host shape.
- `HistoryDb.knownFromPeers` is gone, replaced by candidate 2's echo rule.
- Re-derive and backfill are one budgeted, resumable walk, one day per unit.

## Adjustments made while grafting

Each of these is a judgment call the brief did not spell out. They are recorded so Conan can overrule any of them.

- **The persisted rederive flag is a monotonic counter.** A boolean set by a removal and cleared after the cycle can lose a second removal that arrives mid-cycle. `Asks` holds counters, and the engine saves the count it handled in the same transaction as the walk it started. The same mechanism carries "Apply these deletions", which would otherwise need its own durable flag.
- **The companion port stays open for the browser session.** Candidate 3 connected per cycle. Its applier treats stdin EOF as "Helium quit", so per-cycle connects would spawn an applier at the end of every cycle. Holding the port also keeps the worker alive (P2), which is acceptable in an opt-in mode.
- **No registry.** The brief allowed a registry or one function per model, not both. With two types of different models, one function per model reads more simply and extends with one line.
- **Preview is an overload of `sync`.** It keeps the engine surface at two methods.
- **Two handle slots.** The app page writes `candidate`, and the worker promotes it to `current` on Start. The preview can run against a folder the user has not committed to, and each slot has one writer.
- **`Store.list` is one level deep.** The manifest indexes every file, so listing only discovers peers. That keeps WebDAV to one PROPFIND per poll.
- **Candidate 1's per-shard `rev` is gone.** Manifest `seq` covers rollback for every file a device publishes, and the manifest hash covers torn files.
- **A "Sync history" checkbox at setup.** Decision 1 needs a control in either direction.

## Rejections

- **Candidate 3's history as per-shard register replicas.** Every device republishes everyone's visits, an N-fold bloat. Immutable facts are forced into registers and tombstones. A remote "remove" deletes another device's native visits through `deleteRange`.
- **Candidate 3's `chrome.bookmarks` write quota machinery** (`deferred: quota`, at most 90 writes per apply). The cross-judge believes those constants are deprecated and no longer enforced. Dropped. "Verify bookmark write rate limits on Helium 154" is a listed risk, and the budget seam can absorb throttling if needed.
- **Candidate 2's WebDAV as the v1 default.** It fails "under a minute, no account" for most users. It stays the documented fallback behind the same `Store` port, adopted if P7 lands on rung E, or on rung C if Conan rejects the click.
- **Candidate 2's address-bar hint sink** (one `addUrl` per remote url, stamped now). Out of v1. It still puts misdated rows in `chrome://history`.
- **Candidate 2's `applying()` echo suppression on the channel.** Echo cycles caused by our own bookmark writes simply no-op, because the next read finds `observed == applied`.
- **Candidate 2's pairing string and provider presets.** They exist only for WebDAV, which is not the default.
- **Candidate 3's derived bookmark ids** (`deriveId(device, chromeId)`). Candidate 1's minted uuid plus id map is kept. Both recover through adoption, and one id scheme is simpler to read.
- **Candidate 1's rung E as "companion as the store".** It would make the default path depend on a native install. WebDAV keeps the default within extension APIs.

## Pushback

None of the orchestrator's decisions is broken. The two places where a graft needed a change to work, the session-long companion port and the counter in place of a flag, are recorded above and in `DESIGN.md`.
