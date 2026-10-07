// Native messaging host mode: what Helium launches for the extension. Answers HostRequests in order, reads the
// profile at any time, and never writes Helium's files: `stage` queues changes and wakes the apply helper.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type HelloReply, type HostProtocol, type HostReply, type HostRequest, type ProfileState } from '../../extension/src/profile-mode.ts';
import { frame, readFrames } from './framing.ts';
import { isRecord, parseJsonRecord, valueAt } from './json.ts';
import type { Log } from './log.ts';
import { COMPANION_VERSION, profileDir } from './paths.ts';
import { readProfileFiles, syncedRows, webDataPath } from './profile.ts';
import { loadStore, mergeStaged, overlay, parseAliasPairs, parseStagedChanges, pendingCount, saveStore, withAliases } from './state.ts';
import { openImmutable } from './webdata.ts';

export type HostContext = {
  readonly home: string;
  readonly userDataDir: string;
  /** Start the apply helper unless one already waits for this user data dir. */
  readonly wakeHelper: () => void;
  readonly log: Log;
};

/** Directory and display name of each profile in Local State's `profile.info_cache`. */
export function listProfiles(userDataDir: string): HelloReply['profiles'] {
  const path = join(userDataDir, 'Local State');
  if (!existsSync(path)) return [];
  const cache = valueAt(parseJsonRecord(readFileSync(path, 'utf8'), path), 'profile.info_cache');
  if (!isRecord(cache)) return [];
  return Object.entries(cache).map(([dir, info]) => {
    const name = isRecord(info) ? info['name'] : undefined;
    return { dir, name: typeof name === 'string' ? name : dir };
  });
}

/** An existing profile directory, or an error the extension can show. */
function existingProfile(userDataDir: string, profile: string): string {
  const dir = profileDir(userDataDir, profile);
  if (!existsSync(join(dir, 'Preferences'))) throw new Error(`no profile ${profile} in ${userDataDir}`);
  return dir;
}

function read(ctx: HostContext, profile: string): HostProtocol['read']['res'] {
  const dir = existingProfile(ctx.userDataDir, profile);
  const db = existsSync(webDataPath(dir)) ? openImmutable(webDataPath(dir)) : null;
  try {
    const files = readProfileFiles(dir, db);
    const store = loadStore(ctx.home, ctx.userDataDir, profile);
    const current = syncedRows(files.local, store.aliases);
    const rowsOk = files.webData === 'ok';
    const state: ProfileState = {
      settings: [...overlay(current.settings, store.pending.settings)],
      'search-engines': rowsOk ? [...overlay(current['search-engines'], store.pending['search-engines'])] : [],
      addresses: rowsOk ? [...overlay(current.addresses, store.pending.addresses)] : [],
    };
    return { kind: 'state', state, webData: files.webData, pending: pendingCount(store.pending) };
  } finally {
    db?.close();
  }
}

/** Untrusted message -> a typed request, or why not. */
export function parseRequest(raw: unknown): HostRequest | string {
  if (!isRecord(raw)) return 'request is not an object';
  const { kind, profile } = raw;
  if (kind === 'hello') return { kind };
  if (typeof profile !== 'string') return `${String(kind)}: profile missing`;
  switch (kind) {
    case 'read':
      return { kind, profile };
    case 'bind': {
      const { type } = raw;
      const aliases = parseAliasPairs(raw['aliases']);
      if ((type !== 'search-engines' && type !== 'addresses') || aliases === null) return 'bind: bad type or aliases';
      return { kind, profile, type, aliases };
    }
    case 'stage': {
      const changes = parseStagedChanges(raw['changes']);
      return changes === null ? 'stage: a change does not parse' : { kind, profile, changes };
    }
    default:
      return `unknown request ${String(kind)}`;
  }
}

/** Answer one request. Throws on I/O failure; `serve` turns that into an error reply. */
export function handle(ctx: HostContext, request: HostRequest): HostReply<HostRequest['kind']> {
  switch (request.kind) {
    case 'hello':
      return { kind: 'hello', protocol: PROTOCOL_VERSION, version: COMPANION_VERSION, userDataDir: ctx.userDataDir, profiles: listProfiles(ctx.userDataDir) };
    case 'read':
      return read(ctx, request.profile);
    case 'bind': {
      existingProfile(ctx.userDataDir, request.profile);
      const store = loadStore(ctx.home, ctx.userDataDir, request.profile);
      saveStore(ctx.home, { ...store, aliases: { ...store.aliases, [request.type]: withAliases(store.aliases[request.type], request.aliases) } });
      return { kind: 'ok', pending: pendingCount(store.pending) };
    }
    case 'stage': {
      existingProfile(ctx.userDataDir, request.profile);
      const store = loadStore(ctx.home, ctx.userDataDir, request.profile);
      const { pending } = store;
      const { changes } = request;
      const merged = {
        settings: mergeStaged(pending.settings, changes.settings),
        'search-engines': mergeStaged(pending['search-engines'], changes['search-engines']),
        addresses: mergeStaged(pending.addresses, changes.addresses),
      };
      saveStore(ctx.home, { ...store, pending: merged });
      const count = pendingCount(merged);
      if (count > 0) ctx.wakeHelper();
      return { kind: 'ok', pending: count };
    }
  }
}

/** Serve framed requests from `input` until EOF, one at a time, replying on `output`. */
export async function serve(ctx: HostContext, input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, output: (bytes: Buffer) => Promise<void>): Promise<void> {
  for await (const message of readFrames(input)) {
    const request = message instanceof Error ? `bad JSON: ${message.message}` : parseRequest(message);
    let reply: HostReply<HostRequest['kind']>;
    if (typeof request === 'string') reply = { kind: 'error', message: request };
    else {
      try {
        reply = handle(ctx, request);
      } catch (error) {
        ctx.log(`${request.kind} failed: ${error instanceof Error ? error.stack : String(error)}`);
        reply = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    }
    if (typeof request === 'string') ctx.log(`rejected: ${request}`);
    let bytes: Buffer;
    try {
      bytes = frame(reply);
    } catch (error) {
      bytes = frame({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    await output(bytes);
  }
}
