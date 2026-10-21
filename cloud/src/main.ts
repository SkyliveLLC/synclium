// The shell: environment, the volume guard, node:http <-> Request/Response, the daily purge, and a graceful stop.
// Every rule lives in app.ts or vaults.ts; this is the only code that touches sockets.
//
//   PORT             8080
//   DATA_DIR         /data      the database is $DATA_DIR/cloud.sqlite
//   CLOUD_EPHEMERAL  unset      1 runs without a mounted volume (local runs)
//
// Logs startup, the daily purge count, and unexpected errors. Never a path, token, vault id, or IP.
import { mkdirSync, statSync, statfsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createCloud, type Cloud, type Disk } from './app.ts';
import { LIMITS } from './limits.ts';
import { openVaults } from './vaults.ts';

const DAY_MS = 86_400_000;
const STOP_GRACE_MS = 10_000;
const BASE = 'http://cloud';

/**
 * `req` as a fetch Request, body streamed (app.ts caps it). Null when the request target is not the spelling the
 * URL parser keeps ('..' or '.' segments, a backslash, absolute form): it would reach a key under a second name.
 * Browsers normalize before sending, so only a hand-made request is refused here.
 */
function requestOf(req: IncomingMessage): Request | null {
  const target = req.url ?? '';
  const url = URL.parse(target, BASE);
  if (url === null || `${url.pathname}${url.search}` !== target) return null;
  const headers = new Headers();
  for (const [name, values] of Object.entries(req.headersDistinct)) for (const value of values ?? []) headers.append(name, value);
  const method = req.method ?? 'GET';
  try {
    return new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? null : req, duplex: 'half' });
  } catch {
    return null; // a method fetch forbids (TRACE) or a header value it rejects
  }
}

/**
 * The last X-Forwarded-For entry, else the socket peer. Traefik appends the peer it accepted from, so the last
 * entry is the one a client cannot forge. Correct only while DNS is not proxied (then every user would share a
 * proxy's address).
 */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)?.split(',').at(-1)?.trim();
  return last || (req.socket.remoteAddress ?? '');
}

/** Bodies are at most 8 MiB and already in memory, so one write. A 413's Connection: close ends the socket after it. */
async function send(res: ServerResponse, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(body);
}

/** Serves `cloud` on `port` (0 for any) with the slow-client timeouts. */
export function serve(cloud: Cloud, port: number): Server {
  const server = createServer((req, res) => {
    const request = requestOf(req);
    if (request === null) {
      res.writeHead(400, { Connection: 'close' }).end();
      return;
    }
    cloud
      .handle(request, { ip: clientIp(req) })
      .then((response) => send(res, response))
      .catch((error: unknown) => {
        console.error('unexpected error:', error instanceof Error ? (error.stack ?? error.message) : String(error));
        res.destroy();
      });
  });
  server.headersTimeout = LIMITS.headersTimeoutMs;
  server.requestTimeout = LIMITS.requestTimeoutMs;
  server.listen(port);
  return server;
}

const sizeOf = (path: string): number => statSync(path, { throwIfNoEntry: false })?.size ?? 0;

/** Free space on the volume, and the database with its WAL, re-measured at most every `diskCacheMs`. */
function diskOf(dir: string, db: string): () => Disk {
  let measured: Disk = { freeBytes: 0, dataBytes: 0 };
  let at = -Infinity;
  return () => {
    const now = Date.now();
    if (now - at >= LIMITS.diskCacheMs) {
      const { bavail, bsize } = statfsSync(dir);
      measured = { freeBytes: bavail * bsize, dataBytes: sizeOf(db) + sizeOf(`${db}-wal`) };
      at = now;
    }
    return measured;
  };
}

function main(): void {
  const port = Number(process.env['PORT'] ?? 8080);
  const dir = process.env['DATA_DIR'] ?? '/data';
  mkdirSync(dir, { recursive: true });
  // A volume that failed to mount would put the database in the container's own layer, wiped on every deploy,
  // and every push to main deploys. Exiting fails the health check, so Coolify keeps the old container.
  if (process.env['CLOUD_EPHEMERAL'] !== '1' && statSync(dir).dev === statSync('/').dev) {
    console.error(`refusing to start: ${dir} is not a mounted volume, so a redeploy would wipe it. Mount one, or set CLOUD_EPHEMERAL=1.`);
    process.exit(1);
  }
  const db = join(dir, 'cloud.sqlite');
  const vaults = openVaults(db);
  const server = serve(createCloud({ vaults, disk: diskOf(dir, db) }), port);
  server.once('listening', () => console.log(`Synclium Cloud listening on ${port}`));

  // Two processes purging at once (a rolling deploy) is harmless: the delete is idempotent.
  const purge = (): void => {
    try {
      console.log(`purged ${vaults.purgeIdle(Date.now() - LIMITS.idleDays * DAY_MS)} idle vaults`);
    } catch (error) {
      console.error('purge failed:', error instanceof Error ? error.message : String(error));
    }
  };
  purge();
  const timer = setInterval(purge, DAY_MS);

  // In-flight requests finish; anything cut off the client retries on its next poll, and SQLite's WAL keeps
  // every committed put.
  const stop = (): void => {
    clearInterval(timer);
    server.close(() => {
      vaults.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), STOP_GRACE_MS).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (import.meta.main) main();
