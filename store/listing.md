# Chrome Web Store listing

Copy for the developer dashboard, one section per dashboard field. Images are rendered by `npm run store-assets` in
`extension/`; the upload zip by `npm run package`.

## Store listing

**Name:** Synclium (from the manifest)

**Summary** (132 characters max, from the manifest `description`):
Sync bookmarks, reading list, history and extensions between Helium browsers via your own folder or WebDAV. End-to-end encrypted.

**Category:** Productivity → Tools

**Language:** English

**Description:**

Synclium keeps your bookmarks, reading list, history, and extensions in step across your Helium browsers, with no account and no server of ours.

It syncs through storage you already have:
• a folder you already sync, such as iCloud Drive, Dropbox, or Syncthing, or
• a WebDAV server you already use, such as Nextcloud, ownCloud, Synology, Fastmail, or Koofr.

Everything Synclium writes there is end-to-end encrypted with a sync key that only your devices hold. Your first device creates the key; you paste it on the others. The folder or server only ever sees encrypted files.

What it syncs
• Bookmarks, merged across devices without duplicates. A large unexpected deletion waits for your review instead of spreading.
• Reading list.
• History from the last 90 days (optional). Search your other devices' history from the History page, or type "hs" and a space in the address bar.
• Extensions (optional): see what your other devices have installed and open each one's store page. Nothing is installed for you.

Private by design
• No account, no analytics, no ads, no servers of ours.
• Network requests go only to the WebDAV server you enter, after you grant access to that one address.
• Open source under the MIT license: https://github.com/SkyliveLLC/synclium

Built for Helium; it uses only standard Chromium extension APIs.

**Graphic assets:**
- Store icon: `extension/static/icons/icon-128.png`
- Screenshots (1280x800): `store/screenshots/1-overview.png`, `2-history.png`, `3-setup.png`
- Small promo tile (440x280): `store/promo-tile.png`

**Homepage URL:** https://github.com/SkyliveLLC/synclium
**Support URL:** https://github.com/SkyliveLLC/synclium/issues

## Privacy practices

**Single purpose:**
Sync the user's own browser data (bookmarks, reading list, history, and the list of installed extensions) between the user's own browsers, through a folder or WebDAV server the user controls.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `bookmarks` | Reads bookmarks to sync them to the user's other devices, and applies the changes made on those devices. |
| `readingList` | Reads and updates the reading list to sync it between the user's devices. |
| `history` | Reads the last 90 days of browsing history (only when the user leaves "Sync history" on) so the user can search their other devices' history in the extension and from the address bar. |
| `storage` | Keeps the sync status the popup and pages display. |
| `unlimitedStorage` | The local index of other devices' history and the sync state live in IndexedDB and can exceed the default quota for long histories. |
| `alarms` | Schedules the periodic sync and resumes a sync that was interrupted when the service worker stopped. |
| `management` (optional) | Requested only when the user turns on "Share extensions": lists installed extensions so the user can see which ones their other devices have. Synclium never installs, enables, or removes extensions. |
| `nativeMessaging` (optional) | Requested only when the user opts in to full profile mode in Advanced settings: talks to the companion app the user installs, which applies settings, search engines, and addresses to the browser profile after the browser quits. |
| Host permission `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` (optional) | Requested at runtime for the one WebDAV server address the user enters during setup, so Synclium can read and write its encrypted files there. Nothing is requested if the user syncs through a folder. Plain http is allowed only to this machine. |

**Remote code:** No, I am not using remote code. All JavaScript is in the package; there is no `eval` and no remotely loaded script.

**Data usage** (check these):
- Web history: history and bookmarks/reading list are synced between the user's devices.
- Authentication information: the WebDAV username and app password, kept in local extension storage and sent only to that WebDAV server.

Certify all three: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/SkyliveLLC/synclium/blob/main/PRIVACY.md

## Distribution

**Visibility:** Public. **Regions:** All.

## Notes for the reviewer (optional field)

To test: open the extension's page, choose any empty local folder in step 1 (or a WebDAV URL), keep the generated sync key, name the device, and press Start. Bookmarks and history then appear in the folder as encrypted files under "Helium Sync/". A second browser profile pointed at the same folder with the same key shows the first device's history on the History page.
