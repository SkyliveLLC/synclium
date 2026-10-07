# synclium

A Chrome Web Store extension that syncs bookmarks and history between one person's [Helium](https://helium.computer) browsers, through a folder you already sync (iCloud Drive, Dropbox, Syncthing). No server.

- `extension/`: the extension. `npm install`, then `npm test`, `npm run typecheck`, `npm run build` (output in `extension/dist`, load it unpacked).
- `design/`: the design (`DESIGN.md`) and the design-round records behind it.
- `prototypes/`: throwaway probes that grounded the design against real Helium.

Status: pre-release. Two-device sync works end to end; see `todo.md` for what is open.

## License

MIT. See `LICENSE`.
