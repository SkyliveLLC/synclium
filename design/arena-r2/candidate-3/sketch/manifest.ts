// manifest.json as typed code, emitted at build time. Permissions are the product's blast radius, so they are
// listed once, here, with the reason beside each. Everything optional stays optional until the user opts in.

export const manifest = {
  manifest_version: 3,
  name: 'Helium Sync',
  version: '0.1.0',
  description: 'Sync bookmarks and history between your Helium browsers through a folder you already sync.',
  minimum_chrome_version: '134', // BookmarkTreeNode.folderType

  background: { service_worker: 'worker.js', type: 'module' },
  action: { default_popup: 'popup.html' },
  options_ui: { page: 'setup.html', open_in_tab: true }, // folder picker needs a full page
  omnibox: { keyword: 'hs' }, // "hs rfc 9110" searches synced history
  permissions: [
    'bookmarks', // read and apply
    'history', // read local visits, delete a visit another device deleted
    'storage', // settings and status, observed by pages
    'alarms', // wake a dead worker: poll peers, resume an unfinished cycle
    'unlimitedStorage', // IndexedDB state and the history corpus must not be evicted
  ],
  optional_permissions: ['nativeMessaging'], // file mode only
  optional_host_permissions: ['https://*/*', 'http://*/*'], // WebDAV only; requested for the one origin the user enters
} as const satisfies chrome.runtime.ManifestV3;
