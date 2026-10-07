// Full profile mode's extension side: the native messaging link to the companion, and the three register
// channels over it. The protocol and the record types are profile-mode.ts, shared with the companion.
//
// One link per cycle: background.ts connects, says hello, hands `profileChannels` to the engine, and closes the
// port when the cycle ends. Nothing is written to the profile here; `apply` stages changes, and the companion
// writes them after Helium quits.
import { diffLive } from './crdt.ts';
import { isItemId, type ItemId, type Live, type RegisterType } from './model.ts';
import {
  HOST_NAME,
  addresses,
  isSyncedSetting,
  searchEngines,
  settings,
  type HostProtocol,
  type ProfileState,
  type ProfileTypeName,
  type Rows,
  type StagedChange,
  type StagedChanges,
} from './profile-mode.ts';
import type { ApplyResult, ProfileChannels, RegisterChannel } from './ports.ts';

/** The companion's requests as methods: native messaging in the worker (`connectCompanion`), a fake in tests. */
export type CompanionLink = { readonly [K in keyof HostProtocol]: (req: HostProtocol[K]['req']) => Promise<HostProtocol[K]['res']> };

/** What the last reply said about the profile, for the status line. */
export type ProfileSeen = { readonly pending: number; readonly webData: 'ok' | 'unsupported' };

const TIMEOUT_MS = 10_000;

/** The reply kind each request expects. Anything else, apart from `error`, is a broken companion. */
const REPLY_KIND = { hello: 'hello', read: 'state', bind: 'ok', stage: 'ok' } as const satisfies { readonly [K in keyof HostProtocol]: HostProtocol[K]['res']['kind'] };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The companion is ours, so a reply of the expected kind is trusted in shape; rows are re-parsed by the channels. */
function isReply<K extends keyof HostProtocol>(kind: K, reply: unknown): reply is HostProtocol[K]['res'] {
  return typeof reply === 'object' && reply !== null && 'kind' in reply && reply.kind === REPLY_KIND[kind];
}

/**
 * Open one port to the companion. Requests go one at a time and each takes the next reply. A timeout, a
 * disconnect, or an `error` reply rejects; after a timeout or a disconnect every later request rejects too.
 * Throws at once when `nativeMessaging` is not granted (connectNative exists only after the grant).
 */
export function connectCompanion(): CompanionLink & { readonly close: () => void } {
  if (typeof chrome.runtime.connectNative !== 'function') throw new Error('Synclium is not allowed to talk to the companion yet.');
  const port = chrome.runtime.connectNative(HOST_NAME);
  let closed: string | null = null;
  let waiting: { readonly resolve: (reply: unknown) => void; readonly reject: (error: Error) => void } | null = null;
  const fail = (message: string) => {
    closed ??= message;
    waiting?.reject(new Error(closed));
    waiting = null;
  };
  port.onMessage.addListener((reply: unknown) => {
    const handler = waiting;
    waiting = null;
    handler?.resolve(reply);
  });
  port.onDisconnect.addListener(() => fail(chrome.runtime.lastError?.message ?? 'The companion closed the connection.'));

  let queue: Promise<unknown> = Promise.resolve();
  function request<K extends keyof HostProtocol>(kind: K, req: HostProtocol[K]['req']): Promise<HostProtocol[K]['res']> {
    const sent = queue.then(
      () =>
        new Promise<unknown>((resolve, reject) => {
          if (closed !== null) return reject(new Error(closed));
          const timer = setTimeout(() => {
            fail(`The companion did not answer ${kind} within ${TIMEOUT_MS / 1000} s.`);
            port.disconnect(); // a late reply must not answer the next request
          }, TIMEOUT_MS);
          waiting = {
            resolve: (reply) => {
              clearTimeout(timer);
              resolve(reply);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          port.postMessage({ kind, ...req });
        }),
    );
    queue = sent.catch(() => {});
    return sent.then((reply) => {
      if (isReply(kind, reply)) return reply;
      if (typeof reply === 'object' && reply !== null && 'kind' in reply && reply.kind === 'error' && 'message' in reply) throw new Error(`Companion: ${String(reply.message)}`);
      throw new Error(`The companion answered ${kind} with something else.`);
    });
  }

  return {
    hello: (req) => request('hello', req),
    read: (req) => request('read', req),
    bind: (req) => request('bind', req),
    stage: (req) => request('stage', req),
    close: () => {
      closed ??= 'The link is closed.';
      port.disconnect();
    },
  };
}

const NOTHING_STAGED: StagedChanges = { settings: [], 'search-engines': [], addresses: [] };

/** How one type sits in the protocol's per-type maps. */
type Spec<R extends { readonly kind: string }> = {
  readonly name: ProfileTypeName;
  readonly type: RegisterType<R>;
  /** Null when the companion cannot read this type's rows (an unchecked Web Data version). */
  readonly rows: (state: ProfileState, webData: ProfileSeen['webData']) => Rows<R> | null;
  readonly staged: (changes: readonly StagedChange<R>[]) => StagedChanges;
  /** Settings ids are paths, so they never need a bind. */
  readonly bindAs: 'search-engines' | 'addresses' | null;
};

/**
 * The three channels over one link to one profile. One `read` serves all three: the first type to read fetches
 * it, the other two take the same state, and a type reading again (the next cycle) fetches afresh. `apply`
 * stages the diff in one call and counts as applied, because the companion's read overlays staged changes.
 */
export function profileChannels(link: CompanionLink, dir: string): { readonly channels: ProfileChannels; readonly seen: () => ProfileSeen | null } {
  let state: { readonly reply: HostProtocol['read']['res']; readonly unread: Set<ProfileTypeName> } | null = null;
  let seen: ProfileSeen | null = null;

  async function stateFor(name: ProfileTypeName): Promise<HostProtocol['read']['res']> {
    if (state === null || !state.unread.delete(name)) {
      const reply = await link.read({ profile: dir });
      state = { reply, unread: new Set<ProfileTypeName>(['settings', 'search-engines', 'addresses']) };
      state.unread.delete(name);
      seen = { pending: reply.pending, webData: reply.webData };
    }
    return state.reply;
  }
  const pendingNow = (pending: number) => {
    if (seen !== null) seen = { ...seen, pending };
  };

  function channel<R extends { readonly kind: string }>(spec: Spec<R>): RegisterChannel<R> {
    return {
      /** Rows re-parsed at the boundary like a peer file's; a row the type refuses is not shown at all. */
      async read() {
        const { state: profile, webData } = await stateFor(spec.name);
        const rows = spec.rows(profile, webData);
        if (rows === null) return null;
        const live = new Map<ItemId, R>();
        for (const [id, record] of rows) {
          const parsed = isItemId(id) ? spec.type.parseRecord(record) : null;
          if (parsed !== null) live.set(id, parsed);
        }
        return live;
      },

      async bind(aliases) {
        if (spec.bindAs === null || aliases.size === 0) return;
        pendingNow((await link.bind({ profile: dir, type: spec.bindAs, aliases: [...aliases] })).pending);
      },

      async apply({ current, target }: { readonly current: Live<R>; readonly target: Live<R> }): Promise<ApplyResult> {
        const changes = diffLive(current, target).map(
          (change): StagedChange<R> => ({ id: change.id, before: change.op === 'add' ? null : change.before, after: change.op === 'remove' ? null : change.after }),
        );
        try {
          pendingNow((await link.stage({ profile: dir, changes: spec.staged(changes) })).pending);
        } catch (error) {
          return { kind: 'interrupted', detail: messageOf(error) };
        }
        return { kind: 'applied' };
      },
    };
  }

  const rowsUnless = <R>(rows: Rows<R>, webData: ProfileSeen['webData']): Rows<R> | null => (webData === 'ok' ? rows : null);
  return {
    channels: {
      settings: channel({
        name: 'settings',
        type: settings,
        // Never show a pref outside the allowlist: the merge would drop it and the apply would reset it.
        rows: (profile) => profile.settings.filter(([path]) => isSyncedSetting(path)),
        staged: (changes) => ({ ...NOTHING_STAGED, settings: changes }),
        bindAs: null,
      }),
      searchEngines: channel({
        name: 'search-engines',
        type: searchEngines,
        rows: (profile, webData) => rowsUnless(profile['search-engines'], webData),
        staged: (changes) => ({ ...NOTHING_STAGED, 'search-engines': changes }),
        bindAs: 'search-engines',
      }),
      addresses: channel({
        name: 'addresses',
        type: addresses,
        rows: (profile, webData) => rowsUnless(profile.addresses, webData),
        staged: (changes) => ({ ...NOTHING_STAGED, addresses: changes }),
        bindAs: 'addresses',
      }),
    },
    seen: () => seen,
  };
}
