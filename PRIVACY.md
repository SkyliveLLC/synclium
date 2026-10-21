# Synclium privacy policy

Last updated: 2026-10-21

Synclium syncs your own browser data between your own browsers. It has no account, no analytics, and no ads. If you choose Synclium Cloud, the developer (Skylive LLC) runs the server that stores your encrypted files. It never receives your sync key and cannot read them. If you choose any other storage, Skylive LLC never receives any of your data.

## What Synclium reads

On each device where you set it up, Synclium reads:

- **Bookmarks** and the **reading list**, to sync them.
- **Browsing history** (titles, URLs, and visit times from the last 90 days), only if you leave "Sync history" on during setup.
- **The list of installed extensions** (names and IDs), only if you turn on "Share extensions", which asks for the `management` permission.
- **Browser settings, custom search engines, and saved addresses**, only if you opt in to full profile mode in Advanced settings and install the companion app.

## Where it goes

Synclium writes this data only to the place you choose during setup:

- Synclium Cloud, a server Skylive LLC runs at synclium.skylive.world,
- a "Helium Sync" folder in your own Google Drive, if you sign in to Google during setup,
- a folder on your computer that you already sync (for example iCloud Drive, Dropbox, or Syncthing), or
- a WebDAV server you already use (for example Nextcloud, ownCloud, or Synology).

Every file Synclium writes there is encrypted (AES-256-GCM) with a sync key that is generated on your first device and never leaves your devices. Your other devices get the key only when you paste it in. Synclium Cloud, Google, the folder sync service, or whoever runs the WebDAV server sees encrypted files and device IDs, not your bookmarks or history.

## Synclium Cloud

If you choose Synclium Cloud, each request carries a token derived from your sync key. The token cannot be turned back into the key and opens no file. The server keeps only a hash of it, to keep each sync group's files apart.

Synclium Cloud sees:

- your encrypted files, each with a short fingerprint of your sync key in its header that tells sync groups apart and cannot be used to guess the key,
- your devices' IDs,
- file names, which show which days have history,
- file sizes, and when files are written and read,
- the IP address of each request, used in memory for rate limits.

The web server in front of Synclium Cloud keeps a standard access log for operating the server: the time, IP address, browser user agent, and path of each request (paths contain device IDs and history dates, never your token or file contents). The log is rotated by size and old entries are deleted, usually within two weeks. The Synclium Cloud program itself stores no IP addresses.

It never sees your sync key, your device names, or anything inside your files.

Limits and deletion:

- Synclium Cloud stores up to 64 MB per sync key.
- "Forget this device" in Settings deletes that device's files from Synclium Cloud right away.
- The files of a sync key that sees no write for 180 days are deleted automatically.
- There are no backups. Every device keeps a full copy of what it syncs and uploads it again if the server loses its data.

## What stays on your device

Synclium's working state stays in the browser's local extension storage on each device and is never sent anywhere: the sync key (Synclium Cloud receives only the token derived from it, described above), device name, sync progress, the history index used for searching your other devices' history, your WebDAV address and credentials if you use WebDAV, and your Google account's address if you use Google Drive. The Google access token is kept in memory only and lasts an hour.

The optional companion app (full profile mode) runs on your own computer and talks only to Synclium in the same browser, through Chrome's native messaging. It has no network access of its own.

## Network requests

Synclium sends network requests only to Synclium Cloud (synclium.skylive.world) if you choose it, to the WebDAV server you enter, after you grant access to that one address, or, if you choose Google Drive, to Google's sign-in and Drive API. Synclium Cloud needs no extra permission. With Google Drive, Synclium asks only for the `drive.file` permission: it can see and change only the files it created, never anything else in your Drive. Links on the Extensions page open Chrome Web Store pages when you click them.

## Sharing and sale

Synclium does not sell, share, or transfer your data to anyone, does not use it for advertising or creditworthiness, and does not use it for any purpose other than syncing it between your devices. Its use of data follows the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Removing your data

Uninstalling Synclium removes its local state from that browser. With Synclium Cloud, use "Forget this device" in Settings on each device first to delete its files right away; whatever is left is deleted after 180 days without a write. The encrypted files in your folder or on your WebDAV server belong to you: delete the sync folder (by default named "Helium Sync") to remove them. To revoke Synclium's Google Drive access, remove it at https://myaccount.google.com/permissions.

## Contact

Questions: open an issue at https://github.com/SkyliveLLC/synclium/issues.
