# synclium

A Chrome Web Store extension that syncs bookmarks, history, and the reading list between one person's [Helium](https://helium.computer) browsers, through Synclium Cloud (hosted, no account), your Google Drive, a folder you already sync (iCloud Drive, Dropbox, Syncthing), or a WebDAV server you already have (Nextcloud, ownCloud, Synology). Everything stored is encrypted with a sync key only your devices hold.

- `extension/`: the extension. `npm install`, then `npm test`, `npm run typecheck`, `npm run build` (output in `extension/dist`, load it unpacked).
  `npm run dev` keeps a dev build in `extension/dist-dev` up to date, opens Helium with it loaded (reloading on change), and previews its pages at http://localhost:5174 with fake sync states (`?scenario=`).
  `npm run package` zips the release build for a store upload; `npm run store-assets` re-renders the icons, screenshots, and promo tile.
- Google Drive needs an OAuth client, once per release: in Google Cloud, enable the Drive API, configure the consent screen with the `drive.file` scope, and create a "Web application" OAuth client whose authorized redirect URIs are `https://<extension id>.chromiumapp.org/` (one per id: the Web Store id, and each unpacked id you test with). Put its client id in `GOOGLE_CLIENT_ID` in `extension/src/drive-store.ts`. Without one, setup hides the Google Drive option.
- `cloud/`: Synclium Cloud, the optional hosted store. Node 24, no runtime dependencies, one SQLite file. `npm test`, `npm run typecheck`, `npm start` (`PORT`, `DATA_DIR`; it refuses a `DATA_DIR` on the root filesystem unless `CLOUD_EPHEMERAL=1`).
  Coolify deploys it from this repo: base directory `/cloud`, Dockerfile build, port 8080, a persistent volume at `/data`. Pushes to `main` that change `cloud/` redeploy it (Coolify watch path `cloud/**`). Losing its data loses nothing: devices republish on their next sync.
- `companion/`: the optional companion for full profile mode (macOS, Linux, Windows). `npm install`, then `npm test`, `npm run build` (one binary for the system it runs on, in `companion/dist`; build with an official Node 24, not Homebrew's).
  Users install it with the one command Synclium's Settings page shows, which downloads it from the GitHub release `companion-v<COMPANION_VERSION>` (`extension/src/profile-mode.ts`). Publish that release before a store upload that links to it: bump the version, then push the tag `companion-v<version>` and `release-companion.yml` builds and attaches every system's binary.
- `store/`: the Chrome Web Store listing copy (`listing.md`) and its images. The privacy policy is `PRIVACY.md`.
- `design/`: the design (`DESIGN.md`) and the design-round records behind it.
- `prototypes/`: throwaway probes that grounded the design against real Helium.

Status: pre-release. Two-device sync works end to end; see `todo.md` for what is open.

## License

MIT. See `LICENSE`.
