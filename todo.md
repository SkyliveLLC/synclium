# Helium sync CLI: architect + prototypes (checkpoint before implementation)

## Feature playbook
- [x] 1. `how` over the affected subsystem. (Helium profile on-disk format)
- [x] 2. `architect` for parallel design exploration.
- [x] 3. Throughput checkpoint (blocking first steps / independent workstreams / shared mutable state / smallest safe decomposition)
- [ ] 4. Delegate code-writing. skip: user asked to review before implementation
- [ ] 5. Verify on matching surface. skip: no implementation yet (prototypes verified individually)
- [ ] 6. Rebase into small commits. skip: no implementation yet
- [ ] 7. interrogate if contested. skip for now: base pick was contested but converged; run after sign-off, before shipping
- [ ] 8. Opening a PR. skip: no repo, no implementation

## Architect phases
- [x] A. Ground
- [x] B. Sketch (arena: opus, fable, sonnet)
- [ ] C. Agree (opted in: user review) <- waiting on Conan
- [ ] D. Implement. skip until sign-off
- [ ] E. Scrap. n/a

## Prototype playbook (per open question)
- [x] 1. Scope the decision
- [ ] 2. Gather references. skip: direction set by user (CLI first); grounding came from the real profile
- [x] 3. Build throwaway in scratch dir
- [x] 4. Compare alternatives behind one switcher
- [x] 5. Verify on matching surface (observe output)
- [x] 6. Present alternatives, tradeoffs, recommendation

## Throughput checkpoint
- Blocking first steps: generic register merge (merge.ts) proven against ported P3 scenarios before any profile I/O.
- Independent workstreams: after merge lands, file adapter (profile/), folder store, daemon/CLI frontend touch disjoint files.
- Shared mutable state: store has one writer per key by layout; local state dir is per device; engine runs under a local lock (CLI + daemon on one device).
- Smallest safe decomposition: one owner for merge+bookmarks type, then 2 parallel workers (file adapter, store+daemon+CLI).

- [ ] P4 UI test (Load unpacked persistence via Codex computer use): blocked, screen was locked

## Round 2 (extension direction, Conan 2026-10-06)
- [x] Re-ground: P5 history size, P6 CWS install (CDP)
- [x] Arena r2 (opus folder / fable WebDAV / sonnet open) + fable cross-judge -> base C1
- [x] Synthesis: design/DESIGN.md + design/sketch (tsc --strict exit 0)
- [x] P7 round 1: picker ok on iCloud, worker writes ok, all extensions ok, mtime changes; grant lapses after restart (flag-loaded)
- [x] P7 round 2: rung B confirmed (Allow on every visit persists) (prototypes/p7-fsa), blocked on unlocked screen
- [x] P4 Load-unpacked persists; CWS dialog captured; download blocked in fresh scratch profile
- [x] Conan review: decisions 1-3 accepted (history on, accept rung C, companion v1.1)
- [ ] interrogate after sign-off, before implementation ships

## Unit 1 throughput checkpoint (engine core, in-memory ports)
- Blocking first steps: unit 1 itself. Everything else consumes its ports and types.
- Independent workstreams: none inside unit 1 (model/crdt/engine/scheduler are code-coupled). After it: folder-store (gated on P7), chrome-bookmarks, chrome-history + index, UI.
- Shared mutable state: delegate owns extension/ exclusively; I do not write there while it runs. No git repo, so no worktree; exclusive dir instead.
- Smallest safe decomposition: one owner (fable, strongest judgment: CRDT + crash convergence is the subtle part).
- [x] Unit 1 delegated, verified (typecheck 0, 59/59), casting wrappers inlined, deviations reconciled in DESIGN.md
- [x] Unit 2 (adapters, IndexedDB, worker, UI, build) verified: typecheck 0, 69/69, build ok, screenshots reviewed
- [x] Unit 3 folder-store.ts verified: typecheck 0, 80/80, builds ok
- [x] E2E two-device run passed (setup, join preview, no duplicates, From B crossed, allow-on-every-visit persisted)
- [ ] Popup paused state: make Allow access the primary button
- [ ] Unattended sync after restart without opening popup: unverified in e2e (popup open triggers sync-now)
