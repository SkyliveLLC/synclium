# Chrome Web Store listing

Copy for the developer dashboard, one section per dashboard field. Images are rendered by `npm run store-assets` in
`extension/`; the upload zip by `npm run package`.

## Store listing

**Name:** Synclium (from the manifest)

**Summary** (132 characters max, from the manifest `description`):
Sync bookmarks, reading list, history and extensions between Helium browsers. End-to-end encrypted, no account needed.

**Category:** Productivity → Tools

**Language:** English

**Description:**

Synclium keeps your bookmarks, reading list, history, and extensions in step across your Helium browsers, with no account.

It syncs through:
• Synclium Cloud, with nothing to sign up for: choose it on each device and paste the sync key,
• your Google Drive: sign in on each device, and that's it,
• a folder you already sync, such as iCloud Drive, Dropbox, or Syncthing, or
• a WebDAV server you already use, such as Nextcloud, ownCloud, Synology, Fastmail, or Koofr.

Everything Synclium writes there is end-to-end encrypted with a sync key that only your devices hold. Your first device creates the key; you paste it on the others. Synclium Cloud, Google Drive, the folder, or the server only ever sees encrypted files.

What it syncs
• Bookmarks, merged across devices without duplicates. A large unexpected deletion waits for your review instead of spreading.
• Reading list.
• History from the last 90 days (optional). Search your other devices' history from the History page, or type "hs" and a space in the address bar.
• Extensions (optional): see what your other devices have installed and open each one's store page. Nothing is installed for you.

Private by design
• No account, no analytics, no ads. Synclium Cloud stores only encrypted files and never receives your sync key.
• Network requests go only to the storage you choose: Synclium Cloud, Google Drive (Synclium sees only the files it created there), or the WebDAV server you enter, after you grant access to that one address.
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
Sync the user's own browser data (bookmarks, reading list, history, and the list of installed extensions) between the user's own browsers, through Synclium Cloud or storage the user controls (Google Drive, a synced folder, or a WebDAV server).

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `bookmarks` | Reads bookmarks to sync them to the user's other devices, and applies the changes made on those devices. |
| `readingList` | Reads and updates the reading list to sync it between the user's devices. |
| `history` | Reads the last 90 days of browsing history (only when the user leaves "Sync history" on) so the user can search their other devices' history in the extension and from the address bar. |
| `storage` | Keeps the sync status the popup and pages display. |
| `unlimitedStorage` | The local index of other devices' history and the sync state live in IndexedDB and can exceed the default quota for long histories. |
| `alarms` | Schedules the periodic sync and resumes a sync that was interrupted when the service worker stopped. |
| `identity` | Signs in to Google with `chrome.identity.launchWebAuthFlow` when the user chooses Google Drive as the sync location, with the `drive.file` scope only, so Synclium can read and write the encrypted files it created in the user's Drive. Unused if the user syncs through Synclium Cloud, a folder, or WebDAV. |
| `management` (optional) | Requested only when the user turns on "Share extensions": lists installed extensions so the user can see which ones their other devices have. Synclium never installs, enables, or removes extensions. |
| `nativeMessaging` (optional) | Requested only when the user opts in to full profile mode in Advanced settings: talks to the companion app the user installs, which applies settings, search engines, and addresses to the browser profile after the browser quits. |
| Host permission `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` (optional) | Requested at runtime for the one WebDAV server address the user enters during setup, so Synclium can read and write its encrypted files there. Nothing is requested for Synclium Cloud, Google Drive, or a folder. Plain http is allowed only to this machine. |

**Remote code:** No, I am not using remote code. All JavaScript is in the package; there is no `eval` and no remotely loaded script.

**Data usage** (check these):
- Web history: history and bookmarks/reading list are synced between the user's devices.
- Authentication information: the WebDAV username and app password, kept in local extension storage and sent only to that WebDAV server; with Google Drive, a short-lived Google access token kept in memory and sent only to Google's Drive API; with Synclium Cloud, a token derived from the sync key, sent only to Synclium Cloud.

Certify all three: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/SkyliveLLC/synclium/blob/main/PRIVACY.md

## Distribution

**Visibility:** Public. **Regions:** All.

## Notes for the reviewer (optional field)

To test: open the extension's page, click Use Synclium Cloud in step 1, keep the generated sync key, name the device, and press Start. In a second browser profile, click Use Synclium Cloud and paste the first profile's sync key; the preview names the first device, and after Start its history shows on the History page. Synclium Cloud stores only encrypted files and needs no permission. To test your own storage instead, open "Or use storage you already have" and choose any empty local folder (or a WebDAV URL): bookmarks and history then appear in it as encrypted files under "Helium Sync/".
