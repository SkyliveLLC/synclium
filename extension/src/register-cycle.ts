// The register model's cycle. Bookmarks, the reading list, and full profile mode's settings, search engines, and
// addresses all run through it.
//
// Local-only cycles (no store, or a tripped fuse) still fold, commit, and apply the merge of own and last good
// copies. Edits get stamps near the time they were made, not the time the store came back, so a stale edit
// cannot win last-writer-wins against a peer's newer one.
import type { DeviceId, Hlc, HlcState, ItemId, Rec, RegisterType, Replica } from './model.ts';
import {
  ackedOf,
  collectGarbage,
  diffLive,
  foldLocalChanges,
  massDelete,
  materialize,
  mergeReplicas,
  newestStamp,
  sameLive,
  tick,
  type Change,
} from './crdt.ts';
import type { RegisterChannel, RegisterLocal } from './ports.ts';
import type { Blocked, ChangeSummary, CycleContext, RegisterOutcome, Wanted, Warning } from './engine.ts';
import { encodeRegisterContent, encodeStateFile, fileRel, parseStateFile, plaintextHash, type FileEntry, type RelName, type StateFile } from './store-format.ts';
import { fetchPeerBody } from './peer-file.ts';

export type RegisterStep<R extends Rec> = {
  readonly local: RegisterLocal<R>;
  readonly outcome: RegisterOutcome;
  /** Always our one state file, so publishing never drops it by accident. */
  readonly wanted: ReadonlyMap<RelName, Wanted>;
  readonly warnings: readonly Warning[];
  /** For the setup preview. */
  readonly adopted: { readonly matched: number; readonly toAdd: number; readonly toPublish: number };
};

export type RegisterOptions<R extends Rec> = {
  /** The user confirmed a blocked mass delete. */
  readonly force: boolean;
  /** Persist own state and the ticked clock. Runs before apply and before any put, so a crash loses nothing. */
  readonly commit: (next: RegisterLocal<R>, clock: HlcState) => Promise<void>;
  /** The setup preview: merge and adopt, but bind, commit, and apply nothing. */
  readonly dryRun?: boolean;
};

type PeerFile<R extends Rec> = { readonly seq: number; readonly hash: string; readonly lastGood: StateFile<R> };

type FetchedFile<R extends Rec> = { readonly kind: 'file'; readonly file: StateFile<R> } | { readonly kind: 'keep' } | { readonly kind: 'blocked'; readonly why: Blocked };

async function fetchPeerFile<R extends Rec>(
  ctx: CycleContext,
  type: RegisterType<R>,
  peer: DeviceId,
  rel: RelName,
  entry: FileEntry,
  warnings: Warning[],
): Promise<FetchedFile<R>> {
  const fetched = await fetchPeerBody(ctx, peer, rel, entry, warnings);
  if (fetched === null) return { kind: 'keep' };
  const parsed = parseStateFile(fetched.body, type, { device: peer });
  switch (parsed.kind) {
    case 'ok':
      return { kind: 'file', file: parsed.file };
    case 'newer-type-version':
      return { kind: 'blocked', why: { kind: 'newer-type-version', peer, version: parsed.version } };
    case 'invalid':
      warnings.push({ kind: 'not-yet', peer, file: rel });
      return { kind: 'keep' };
    default: {
      const unreachable: never = parsed;
      return unreachable;
    }
  }
}

export function summarize<R extends Rec>(changes: readonly Change<R>[], label: (record: R) => string): ChangeSummary {
  const count = (op: Change<R>['op']) => changes.filter((c) => c.op === op).length;
  return {
    added: count('add'),
    updated: count('update'),
    removed: count('remove'),
    sample: changes.slice(0, 5).map((c) => label(c.op === 'remove' ? c.before : c.after)),
  };
}

const NO_CHANGES: ChangeSummary = { added: 0, updated: 0, removed: 0, sample: [] };

function countStamped<R extends Rec>(replica: Replica<R>, stamp: Hlc): number {
  let n = 0;
  for (const entry of replica.values()) {
    const view: { readonly fields: { readonly [field: string]: readonly [unknown, Hlc] } } = entry;
    if (entry.deleted[1] === stamp) n++;
    for (const [, at] of Object.values(view.fields)) if (at === stamp) n++;
  }
  return n;
}

export async function syncRegisters<R extends Rec>(
  ctx: CycleContext,
  type: RegisterType<R>,
  channel: RegisterChannel<R>,
  state: RegisterLocal<R> | null,
  opts: RegisterOptions<R>,
): Promise<RegisterStep<R>> {
  const rel = fileRel(type);
  const tl: RegisterLocal<R> = state ?? { own: new Map(), acked: new Map(), seq: 0, applied: null, peers: new Map() };
  const warnings: Warning[] = [];
  const dryRun = opts.dryRun === true;
  const noAdoption = { matched: 0, toAdd: 0, toPublish: 0 };

  const ownFile = (local: RegisterLocal<R>, plain: string, writtenAt: Hlc): ReadonlyMap<RelName, Wanted> =>
    new Map([
      [
        rel,
        {
          plain,
          body: async () =>
            encodeStateFile({ device: ctx.me.device, type: type.name, typeVersion: type.version, seq: local.seq, writtenAt, acked: local.acked, replica: local.own }),
        },
      ],
    ]);

  // Peer files: one fetch per live peer whose manifest names a hash we have not parsed yet.
  const peers = new Map<DeviceId, PeerFile<R>>();
  let blocked: Blocked | null = null;
  for (const [peer, manifest] of ctx.live) {
    const held = tl.peers.get(peer);
    const entry = manifest.files.get(rel);
    if (entry !== undefined && held?.hash !== entry.hash) {
      const fetched = await fetchPeerFile(ctx, type, peer, rel, entry, warnings);
      if (fetched.kind === 'file') {
        if (held !== undefined && fetched.file.seq < held.seq) warnings.push({ kind: 'rollback', peer });
        else {
          peers.set(peer, { seq: fetched.file.seq, hash: entry.hash, lastGood: fetched.file });
          continue;
        }
      } else if (fetched.kind === 'blocked') blocked = fetched.why;
    }
    if (held !== undefined) peers.set(peer, held);
  }

  const remote = mergeReplicas([tl.own, ...[...peers.values()].map((p) => p.lastGood.replica)]);
  const { state: clock, stamp } = tick(ctx.me.clock, ctx.now, newestStamp([remote]), ctx.me.device);
  const prevPlain = await plaintextHash(encodeRegisterContent({ acked: tl.acked, replica: tl.own }));

  if (blocked !== null) return { local: tl, outcome: { kind: 'blocked', why: blocked }, wanted: ownFile(tl, prevPlain, stamp), warnings, adopted: noAdoption };

  // Adoption: local nodes the merge does not know take the ids of equal-content synced items nobody shows.
  const raw = await channel.read(tl.applied);
  if (raw === null) return { local: tl, outcome: { kind: 'off' }, wanted: ownFile(tl, prevPlain, stamp), warnings, adopted: noAdoption };
  const remoteLive = materialize(remote, type.normalize);
  const unclaimed = new Map<ItemId, R>();
  for (const [id, record] of remoteLive) if (!raw.has(id) && !(tl.applied?.has(id) ?? false)) unclaimed.set(id, record);
  const adopted = type.adopt({ local: raw, synced: remoteLive, unclaimed, isKnown: (id) => remote.has(id) });
  if (adopted.aliases.size > 0 && !dryRun) await channel.bind(adopted.aliases);
  const observed = adopted.live;
  let known = 0;
  for (const id of raw.keys()) if (remote.has(id)) known++;
  const matched = adopted.aliases.size + known;
  const adoption = { matched, toAdd: unclaimed.size - adopted.aliases.size, toPublish: raw.size - matched };

  const guard = massDelete(tl.applied, observed, ctx.policy.massDelete, type.emptyReadIsSuspect);
  if (guard !== null && !opts.force && tl.applied !== null) {
    const removed = summarize(diffLive(tl.applied, observed).filter((c) => c.op === 'remove'), type.label);
    return { local: tl, outcome: { kind: 'blocked', why: { kind: 'mass-delete', removed, of: guard.of } }, wanted: ownFile(tl, prevPlain, stamp), warnings, adopted: adoption };
  }

  const folded = foldLocalChanges(remote, tl.applied, observed, stamp);
  const acked = ackedOf(folded, tl.acked);
  const merged = collectGarbage(folded, [acked, ...[...peers.values()].map((p) => p.lastGood.acked)], type.references);
  const target = materialize(merged, type.normalize);
  const plain = await plaintextHash(encodeRegisterContent({ acked, replica: merged }));
  let local: RegisterLocal<R> = { own: merged, acked, seq: plain === prevPlain ? tl.seq : tl.seq + 1, applied: tl.applied, peers };
  if (!dryRun) await opts.commit(local, clock);
  const stamped = countStamped(merged, stamp);

  let outcome: RegisterOutcome;
  if (sameLive(observed, target)) {
    local = { ...local, applied: target };
    outcome = { kind: 'synced', stamped, applied: NO_CHANGES };
  } else if (dryRun || ctx.budget.expired()) {
    outcome = { kind: 'pending', why: 'budget', pending: summarize(diffLive(observed, target), type.label) };
  } else {
    const result = await channel.apply({ current: observed, target }, ctx.budget);
    switch (result.kind) {
      case 'applied':
        local = { ...local, applied: target };
        outcome = { kind: 'synced', stamped, applied: summarize(diffLive(observed, target), type.label) };
        break;
      case 'stopped':
        outcome = { kind: 'pending', why: 'budget', pending: summarize(diffLive(observed, target), type.label) };
        break;
      case 'interrupted':
        outcome = { kind: 'pending', why: 'interrupted', pending: summarize(diffLive(observed, target), type.label) };
        break;
      default: {
        const unreachable: never = result;
        return unreachable;
      }
    }
  }
  return { local, outcome, wanted: ownFile(local, plain, stamp), warnings, adopted: adoption };
}

