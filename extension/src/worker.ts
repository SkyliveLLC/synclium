// Release entry. Syncs through the folder the user picked in setup (folder-store.ts).
import { startWorker } from './background.ts';
import { folderBackend } from './folder-store.ts';

startWorker(folderBackend);
