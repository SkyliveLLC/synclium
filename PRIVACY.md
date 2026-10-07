# Synclium privacy policy

Last updated: 2026-10-07

Synclium syncs your own browser data between your own browsers. It has no server, no account, no analytics, and no ads. The developer (Skylive LLC) never receives, sees, or stores any of your data.

## What Synclium reads

On each device where you set it up, Synclium reads:

- **Bookmarks** and the **reading list**, to sync them.
- **Browsing history** (titles, URLs, and visit times from the last 90 days), only if you leave "Sync history" on during setup.
- **The list of installed extensions** (names and IDs), only if you turn on "Share extensions", which asks for the `management` permission.
- **Browser settings, custom search engines, and saved addresses**, only if you opt in to full profile mode in Advanced settings and install the companion app.

## Where it goes

Synclium writes this data to a place **you** choose and control, and nowhere else:

- a folder on your computer that you already sync (for example iCloud Drive, Dropbox, or Syncthing), or
- a WebDAV server you already use (for example Nextcloud, ownCloud, or Synology).

Every file Synclium writes there is encrypted (AES-256-GCM) with a sync key that is generated on your first device and never written to the folder or server. Your other devices get the key only when you paste it in. Whoever runs the folder sync service or the WebDAV server sees encrypted files and device IDs, not your bookmarks or history.

## What stays on your device

Synclium's working state stays in the browser's local extension storage on each device and is never sent anywhere: the sync key, device name, sync progress, the history index used for searching your other devices' history, and your WebDAV address and credentials if you use WebDAV.

The optional companion app (full profile mode) runs on your own computer and talks only to Synclium in the same browser, through Chrome's native messaging. It has no network access of its own.

## Network requests

Synclium sends network requests only to the WebDAV server you enter, and only after you grant access to that one address. Links on the Extensions page open Chrome Web Store pages when you click them.

## Sharing and sale

Synclium does not sell, share, or transfer your data to anyone, does not use it for advertising or creditworthiness, and does not use it for any purpose other than syncing it between your devices. Its use of data follows the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Removing your data

Uninstalling Synclium removes its local state from that browser. The encrypted files in your folder or on your WebDAV server belong to you: delete the sync folder (by default named "Helium Sync") to remove them.

## Contact

Questions: open an issue at https://github.com/SkyliveLLC/synclium/issues.
