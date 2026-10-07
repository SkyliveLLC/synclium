// `npm run dev`: one dev build, three ways to look at it.
//   1. dist-dev/ is kept built (tsc --watch for src/, a copy for static/). The dev entry syncs against
//      dev-store.ts, never a real folder.
//   2. Helium starts with dist-dev/ loaded in a throwaway profile (web-ext run), and the extension reloads itself
//      whenever dist-dev/ changes. HELIUM_BIN overrides where Helium lives; --no-browser skips this step.
//   3. http://localhost:5174 serves the same pages in a normal tab with a fake `chrome` (dev/chrome-mock.ts) and
//      reloads them on every change. Pick a state with the toolbar or ?scenario=, e.g. /app.html?scenario=review.
// PORT overrides the port. Edits to static/manifest.json need a restart.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'dist-dev');
const port = Number(process.env.PORT ?? 5174);
const helium = process.env.HELIUM_BIN ?? '/Applications/Helium.app/Contents/MacOS/Helium';

execFileSync(process.execPath, [join(root, 'scripts/build.mjs'), '--dev'], { stdio: 'inherit' });
const tsc = spawn(join(root, 'node_modules/.bin/tsc'), ['-p', join(root, 'tsconfig.build-dev.json'), '--watch', '--preserveWatchOutput'], { stdio: 'inherit' });
const children = [tsc];
if (process.argv.includes('--no-browser')) console.log('[dev] --no-browser: not starting Helium');
else if (!existsSync(helium)) console.log(`[dev] no Helium at ${helium}; set HELIUM_BIN to start it with the extension loaded`);
else
  children.push(
    spawn(join(root, 'node_modules/.bin/web-ext'), ['run', '--target', 'chromium', '--chromium-binary', helium, '--source-dir', out, '--no-input'], { stdio: 'inherit' }),
  );
process.on('exit', () => children.forEach((child) => child.kill()));
process.on('SIGINT', () => process.exit(0));

watch(join(root, 'static'), (_event, name) => {
  if (name === null) return;
  if (name === 'manifest.json') return console.log('[dev] manifest.json changed: restart npm run dev to rebuild it');
  try {
    copyFileSync(join(root, 'static', name), join(out, name));
  } catch {} // a file deleted or mid-save; the next event copies it
});

// ---------- Live reload: one server-sent event per batch of changes ----------

const clients = new Set();
let pending;
const changed = () => {
  clearTimeout(pending);
  pending = setTimeout(() => {
    for (const res of clients) res.write('event: reload\ndata: \n\n');
  }, 120);
};
watch(out, { recursive: true }, changed);
watch(join(root, 'dev'), changed);

// ---------- Preview server ----------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
// The fake chrome and the reload listener run before the page's own module, because module scripts run in order.
const INJECT =
  '<script type="module" src="/__dev/chrome-mock.js"></script>\n' +
  '  <script type="module">new EventSource("/__dev/events").addEventListener("reload", () => location.reload());</script>\n  ';

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/') return void res.writeHead(302, { location: '/app.html#status' }).end();
  if (pathname === '/__dev/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    clients.add(res);
    return void req.on('close', () => clients.delete(res));
  }
  try {
    if (pathname === '/__dev/chrome-mock.js') {
      const js = stripTypeScriptTypes(readFileSync(join(root, 'dev/chrome-mock.ts'), 'utf8'));
      return void res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }).end(js);
    }
    const file = join(out, normalize(pathname)); // normalize resolves `..` against the leading /
    if (!file.startsWith(out)) return void res.writeHead(403).end();
    let body = readFileSync(file);
    if (extname(file) === '.html') body = body.toString().replace('<script type="module"', `${INJECT}<script type="module"`);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`[dev] preview on http://localhost:${port}  (extension build in ${out})`));
