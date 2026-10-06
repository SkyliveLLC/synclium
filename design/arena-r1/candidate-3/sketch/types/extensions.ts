// Worked example of "one registry entry": an observed type. No merge, no apply.
// Each device publishes its own list; `engine.others("extensions")` shows what other devices have
// that this one lacks. The user installs by hand (installing is blocked by Secure Preferences MACs).
import type { ObservedType } from "../registry.ts";

export interface ExtensionList { extensions: { id: string; name: string; version: string; enabled: boolean }[] }

export const extensions: ObservedType<"extensions", ExtensionList> = {
  kind: "observed",
  id: "extensions",
  version: 1,
  parseSnapshot: (_raw) => { throw new Error("not implemented"); },
};
// To ship it: add `extensions` to the registry in index.ts, and give each Profile adapter a read-only
// channel("extensions") (file-profile: Preferences JSON; live-profile: chrome.management.getAll).
