// The register model's cycle: round 1's per-type body, unchanged in substance. Bookmarks run through it; a
// future register type (settings, search engines) would too. Changes from round 1 are marked [r2].
import type { Rec, RegisterType } from './model.ts';
import type { RegisterChannel, RegisterLocal } from './ports.ts';
import type { CycleContext, RegisterOutcome, Wanted, Warning } from './engine.ts';
import type { RelName } from './store-format.ts';

export type RegisterStep<R extends Rec> = {
  readonly local: RegisterLocal<R>;
  readonly outcome: RegisterOutcome;
  /** Always our one state file, so publishing never drops it by accident. */
  readonly wanted: ReadonlyMap<RelName, Wanted>;
  readonly warnings: readonly Warning[];
  /** For the setup preview. */
  readonly adopted: { readonly matched: number; readonly toAdd: number; readonly toPublish: number };
};

/*
 * syncRegisters(ctx, type, channel, state, force, commit):
 *
 *   tl    = state ?? fresh
 *   files = per live peer p, entry = p.manifest.files[registerRel(type)]:                        [r2]
 *             no store, no entry, or entry.hash == tl.peers[p].hash  -> tl.peers[p].lastGood
 *             else open(get(key), codec, entry) -> parseStateFile
 *               not-yet / unknown codec       -> lastGood, warn
 *               seq below tl.peers[p].seq     -> lastGood, warn rollback
 *               newer type version            -> blocked
 *   remote  = mergeReplicas([tl.own, ...files]); stamp = tick(...)
 *   raw     = channel.read(tl.applied)
 *   adopted = type.adopt({ local: raw, unclaimed, isKnown }); channel.bind(adopted.aliases)
 *   massDelete(tl.applied, adopted.live) and not force                  -> blocked mass-delete
 *   merged  = collectGarbage(foldLocalChanges(remote, tl.applied, adopted.live, stamp), acks)
 *   target  = materialize(merged, type.normalize)
 *   plain   = plaintextHash(merged + acked)
 *   plain != ctx.me.published[rel].plain: commit({ own: merged, seq: seq + 1 })    // before apply and publish
 *   adopted.live == target -> applied = target
 *   else r = channel.apply({ current: adopted.live, target }, ctx.budget)                         [r2]
 *        applied moves only on 'applied'; 'stopped' -> pending budget; 'interrupted' -> pending interrupted
 *   wanted  = { rel: { plain, body: () => encodeStateFile({ seq, acked, replica: merged, ... }) } }
 *
 *   [r2] Local-only cycles (ctx.store null) still fold, commit, and apply the merge of own and last good
 *   copies. Edits get stamps near the time they were made, not the time the store came back, so a stale
 *   edit cannot win last-writer-wins against a peer's newer one.
 */
export function syncRegisters<R extends Rec>(
  _ctx: CycleContext,
  _type: RegisterType<R>,
  _channel: RegisterChannel<R>,
  _state: RegisterLocal<R> | null,
  _opts: { readonly force: boolean; readonly commit: (next: RegisterLocal<R>) => Promise<void> },
): Promise<RegisterStep<R>> {
  throw new Error('not implemented');
}

