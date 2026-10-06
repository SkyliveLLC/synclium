// Composition root for the library. The registry is the single list of data types.
import { defineRegistry } from "./registry.ts";
import { bookmarks } from "./types/bookmarks.ts";

export const registry = defineRegistry({ bookmarks });
export type HeliumRegistry = typeof registry;
// Adding a type: `import { extensions } from "./types/extensions.ts"` and add it above.

/*
 * MODULE MAP (dependency direction is downward; a trace never needs more than 3 files)
 *
 *   cli.ts                   frontend: argv -> adapters -> engine. No logic.
 *     engine.ts              sync cycle, reports, EngineApi (the cross-process frontend boundary)
 *       registry.ts          MergedType / ObservedType, derived LocalOf / ChangeOf
 *         types/bookmarks.ts v1 type: LWW registers + HLC, fractional positions, adoption   (pure)
 *         types/extensions.ts  worked example of adding an observed type (v1.1)            (pure)
 *       vault.ts             key custody, invite/join/rotate (pairing)
 *         envelope.ts        store key layout, StateFile, AES-GCM envelope
 *       ports.ts             Store, Profile/ProfileSession/Channel, LocalState, SecretStore, Clock
 *         adapters/folder-store.ts   Store over a directory (iCloud/Dropbox/Syncthing)
 *         adapters/file-profile.ts   Profile over Bookmarks JSON; writes only when browser is closed
 *         adapters/live-profile.ts   Profile over extension + native-messaging socket (v2); wraps file-profile
 *   ids.ts                   brands, Hlc, Reg
 *
 * Wire formats (Chromium JSON, native-messaging frames, envelope bytes) live in adapters/ and
 * envelope.ts. Nothing above ports.ts imports them.
 */
