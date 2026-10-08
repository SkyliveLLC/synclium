# synclium

A Chrome Web Store extension that syncs bookmarks, history, and the reading list between one person's [Helium](https://helium.computer) browsers, through your Google Drive, a folder you already sync (iCloud Drive, Dropbox, Syncthing), or a WebDAV server you already have (Nextcloud, ownCloud, Synology). No server of ours, and everything in the store is encrypted with a sync key only your devices hold.

- `extension/`: the extension. `npm install`, then `npm test`, `npm run typecheck`, `npm run build` (output in `extension/dist`, load it unpacked).
  `npm run dev` keeps a dev build in `extension/dist-dev` up to date, opens Helium with it loaded (reloading on change), and previews its pages at http://localhost:5174 with fake sync states (`?scenario=`).
  `npm run package` zips the release build for a store upload; `npm run store-assets` re-renders the icons, screenshots, and promo tile.
- Google Drive needs an OAuth client, once per release: in Google Cloud, enable the Drive API, configure the consent screen with the `drive.file` scope, and create a "Web application" OAuth client whose authorized redirect URIs are `https://<extension id>.chromiumapp.org/` (one per id: the Web Store id, and each unpacked id you test with). Put its client id in `GOOGLE_CLIENT_ID` in `extension/src/drive-store.ts`. Without one, setup hides the Google Drive option.
- `store/`: the Chrome Web Store listing copy (`listing.md`) and its images. The privacy policy is `PRIVACY.md`.
- `design/`: the design (`DESIGN.md`) and the design-round records behind it.
- `prototypes/`: throwaway probes that grounded the design against real Helium.

Status: pre-release. Two-device sync works end to end; see `todo.md` for what is open.

## License

MIT. See `LICENSE`.
