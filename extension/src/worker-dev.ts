// DEVELOPMENT entry, built only by `npm run build:dev` into dist-dev/. Syncs against dev-store.ts, which keeps
// "the folder" in this profile's chrome.storage.local.
import { startWorker } from './background.ts';
import { devStoreBackend } from './dev-store.ts';

startWorker(devStoreBackend);
