// File System Access members Chromium ships but TypeScript's DOM lib omits (they are not in the WHATWG File
// System standard). Declared at the boundary, so folder-store.ts needs no cast.
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}
interface FileSystemHandle {
  /** Never prompts. Works in the service worker as well as pages (observed in P7). */
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  /** Needs a user gesture, so an extension page inside a click. */
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}
interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads';
  }): Promise<FileSystemDirectoryHandle>;
}
