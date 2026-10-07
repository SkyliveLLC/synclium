// Release entry. Syncs through the folder or WebDAV server the user chose in setup (stores.ts).
import { startWorker } from './background.ts';
import { releaseBackend } from './stores.ts';

startWorker(releaseBackend);
