// This device's extensions through chrome.management, an optional permission the user grants on the
// Extensions page. Without it the list is not read and nothing is published.
import type { ExtensionList, ExtensionSource } from './extensions.ts';
import type { SnapshotSource } from './ports.ts';

const sourceOf = (installType: chrome.management.ExtensionInfo['installType']): ExtensionSource =>
  installType === 'normal' ? 'store' : installType === 'development' ? 'unpacked' : 'other';

export function chromeExtensionsSource(): SnapshotSource<ExtensionList> {
  return {
    async read() {
      if (!(await chrome.permissions.contains({ permissions: ['management'] }))) return null;
      return (await chrome.management.getAll())
        .filter((ext) => ext.id !== chrome.runtime.id && (ext.type === 'extension' || ext.type === 'theme'))
        .map((ext) => ({ id: ext.id, name: ext.name, enabled: ext.enabled, source: sourceOf(ext.installType) }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}
