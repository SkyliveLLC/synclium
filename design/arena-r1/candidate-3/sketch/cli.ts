// Thin frontend. Parses argv, builds adapters, calls the engine, prints the report.
//
//   helium-sync init   <folder>                create vault in a synced folder, print recovery key
//   helium-sync invite                         print a 15-minute pairing token
//   helium-sync join   <folder> <token>        pair this device (token typed/pasted from the other device)
//   helium-sync sync   [--dry-run] [--force]   one cycle
//   helium-sync watch                          sync on change until Ctrl-C
//   helium-sync status | devices | revoke <device>
//
// The folder path is per device (each machine mounts the same cloud folder somewhere else);
// it is saved in ~/.config/helium-sync/config.json together with the profile path.
export function main(_argv: readonly string[]): Promise<number> {
  throw new Error("not implemented");
}
