# synclium

A Chrome Web Store extension that syncs bookmarks, history, and the reading list between one person's [Helium](https://helium.computer) browsers, through a folder you already sync (iCloud Drive, Dropbox, Syncthing) or a WebDAV server you already have (Nextcloud, ownCloud, Synology). No server of ours, and everything in the store is encrypted with a sync key only your devices hold.

- `extension/`: the extension. `npm install`, then `npm test`, `npm run typecheck`, `npm run build` (output in `extension/dist`, load it unpacked).
  `npm run dev` keeps a dev build in `extension/dist-dev` up to date, opens Helium with it loaded (reloading on change), and previews its pages at http://localhost:5174 with fake sync states (`?scenario=`).
- `design/`: the design (`DESIGN.md`) and the design-round records behind it.
- `prototypes/`: throwaway probes that grounded the design against real Helium.

Status: pre-release. Two-device sync works end to end; see `todo.md` for what is open.

## License

MIT. See `LICENSE`.
