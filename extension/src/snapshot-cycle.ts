// The snapshot model's cycle: publish this device's state whole, keep each live peer's last good copy. No
// stamps, no merge, no apply; the UI decides what a peer's snapshot offers here.
import type { DeviceId, Json, SnapshotType } from './model.ts';
import type { SnapshotLocal, SnapshotSource } from './ports.ts';
import type { CycleContext, Wanted, Warning } from './engine.ts';
import { encodeSnapshotFile, fileRel, parseSnapshotFile, plaintextHash, type RelName } from './store-format.ts';
import { fetchPeerBody } from './peer-file.ts';

export type SnapshotStep<S extends Json> = {
  readonly local: SnapshotLocal<S>;
  /** Empty when the source cannot be read: the file leaves our manifest and peers drop it. */
  readonly wanted: ReadonlyMap<RelName, Wanted>;
  readonly warnings: readonly Warning[];
};

export async function syncSnapshot<S extends Json>(ctx: CycleContext, type: SnapshotType<S>, source: SnapshotSource<S>, state: SnapshotLocal<S> | null): Promise<SnapshotStep<S>> {
  const rel = fileRel(type);
  const warnings: Warning[] = [];
  const peers = new Map<DeviceId, { readonly hash: string; readonly content: S }>();
  for (const [peer, manifest] of ctx.live) {
    const entry = manifest.files.get(rel);
    if (entry === undefined) continue;
    const held = state?.peers.get(peer);
    if (held?.hash === entry.hash) {
      peers.set(peer, held);
      continue;
    }
    const fetched = await fetchPeerBody(ctx, peer, rel, entry, warnings);
    const parsed = fetched === null ? null : parseSnapshotFile(fetched.body, type, { device: peer });
    if (parsed?.kind === 'ok') {
      peers.set(peer, { hash: entry.hash, content: parsed.file.content });
      continue;
    }
    if (parsed?.kind === 'newer-type-version') warnings.push({ kind: 'newer-version', peer, file: rel, version: parsed.version });
    if (parsed?.kind === 'invalid') warnings.push({ kind: 'not-yet', peer, file: rel });
    if (held !== undefined) peers.set(peer, held);
  }

  const content = await source.read();
  if (content === null) return { local: { peers }, wanted: new Map(), warnings };
  const body = encodeSnapshotFile({ device: ctx.me.device, type: type.name, typeVersion: type.version, content });
  return { local: { peers }, wanted: new Map([[rel, { plain: await plaintextHash(body), body: async () => body }]]), warnings };
}
