// LogChannel<Visit> over chrome.history. The only module that knows HistoryItem, VisitItem, and the sinks.
//
// collect(cursor):
//   search({ text: '', startTime: cursor.collectedTo - 60s, maxResults: 100000 }) lists urls with activity,
//   then getVisits({ url }) per url, keeping visits with t > collectedTo. One day of backfill per call,
//   newest first, from cursor.backfillBefore, until retention is reached (then backfillBefore = null).
//   Backfill of a 90-day profile is ~17k getVisits calls (P5); daily chunks keep each call under a minute
//   and a service-worker death costs at most one day.
//   Echo rule: a visit whose key `local.ingested` knows is one a sink created (addUrl hint, or the companion's
//   import appearing after a restart) and is dropped. Hints are stamped "now" by Chromium, so the hint sink
//   records the key with the t it observed from onVisited, not the remote t.
//
// ingest(from, events): what "apply" means for history, since addUrl cannot set visitTime (P2):
//   1. view     always. Writes events into the `visits` object store that the Synced history page reads:
//               full fidelity (device, real time, title, transition), searchable, zero writes to Helium's history.
//   2. hints    opt-in setting. For a url that local history does not contain, one addUrl so the address bar
//               can suggest it. At most once per url, never per visit, and recorded as an echo. The entry is
//               untitled and stamped now; that is the whole cost, and the setting says so.
//   3. native   opt-in file mode. Stages (url, title, t, transition) with the companion, which writes them
//               into History SQLite with the real visit_time once Helium is closed. See native-host.ts.
//   Sinks run in that order and are idempotent on key, so a re-ingest after a crash is harmless.
import type { DeviceId } from '../model.ts';
import type { LogChannel } from '../ports.ts';
import type { Visit } from '../types/history.ts';

export interface HistorySink {
  ingest(from: DeviceId, events: readonly Visit[]): Promise<void>;
}

export type HistoryOptions = {
  readonly view: HistorySink;
  readonly hints: HistorySink | null;
  readonly native: HistorySink | null;
};

export function chromeHistoryChannel(_opts: HistoryOptions): LogChannel<Visit> {
  throw new Error('not implemented');
}

/** Sink 1. IndexedDB store `visits`, keyed by `${t}|${url}`, indexed by t and by device. */
export function viewSink(): HistorySink & SyncedHistoryQuery {
  throw new Error('not implemented');
}

/** What the Synced history page asks. Runs in the options page against the same IndexedDB; no message to the worker. */
export interface SyncedHistoryQuery {
  search(q: { readonly text: string; readonly from: number; readonly to: number; readonly devices: readonly DeviceId[] | null; readonly limit: number }): Promise<readonly (Visit & { readonly device: DeviceId })[]>;
  /** The options page's "Delete my synced history": local view rows for this device. The engine deletes the shards. */
  forgetDevice(device: DeviceId): Promise<void>;
}

/** Sink 2. `chrome.history.getVisits({ url })` empty -> `chrome.history.addUrl({ url })`, then record the echo key. */
export function omniboxHintSink(_markEcho: (keys: readonly string[]) => Promise<void>): HistorySink {
  throw new Error('not implemented');
}

/** Boundary: API visits to domain events. Title comes from the HistoryItem the visit was listed under. */
function toVisits(_item: chrome.history.HistoryItem, _visits: readonly chrome.history.VisitItem[]): readonly Visit[] {
  throw new Error('not implemented');
}
