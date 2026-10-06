// Wire contract between the extension and the opt-in companion host. Private to companion/: nothing outside
// this folder imports it. Native messaging frames are JSON; host -> extension messages stay under 1 MB.

export const HOST_NAME = 'net.helium_sync.companion';

/** A peer visit to put into Helium's History database at its real time. */
export type StagedVisit = { readonly url: string; readonly title: string; readonly t: number };

export type ToHost =
  | { readonly kind: 'hello'; readonly extensionVersion: string }
  /** Idempotent and cumulative. The host dedupes by (url, visit_time). */
  | { readonly kind: 'stage'; readonly visits: readonly StagedVisit[] };

/** What the applier did the last time Helium closed. Shown in app.html#advanced. */
export type Receipt = { readonly at: number; readonly inserted: number; readonly alreadyPresent: number; readonly backup: string };

export type FromHost =
  | {
      readonly kind: 'hello';
      readonly hostVersion: string;
      /** True when the host's staging dir is new or was reset: the extension stages the whole index once. */
      readonly needsBacklog: boolean;
      readonly lastApply: Receipt | null;
    }
  | { readonly kind: 'staged'; readonly pending: number }
  | { readonly kind: 'error'; readonly message: string };
