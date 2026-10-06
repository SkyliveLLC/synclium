// File System Access members Chromium ships but TypeScript's DOM lib omits (they are not in the WHATWG
// File System standard). Declared here, at the boundary, so nothing else needs a cast.
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}
interface FileSystemHandle {
  /** Never prompts. Available wherever the handle is (page, offscreen document, and, unverified, the service worker). */
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  /** Needs a user gesture, so a page only. */
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}
interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads';
  }): Promise<FileSystemDirectoryHandle>;
}
