// `npm run store-assets`: renders what the Chrome Web Store and the manifest need, with headless Chrome.
//   static/icons/icon-{16,32,48,128}.png  from assets/icon.svg (the 128 one is 96 px of art in 16 px of padding,
//                                         as the store asks; the toolbar sizes fill their square)
//   ../store/promo-tile.png               the 440x280 small promo tile
//   ../store/screenshots/*.png            1280x800 shots of the app pages, from the dev preview's fake states
// CHROME_BIN overrides where Chrome lives. The outputs are committed; rerun after changing the icon or the UI.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const chrome = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const scratch = mkdtempSync(join(tmpdir(), 'synclium-assets-'));

function shot(url, out, width, height) {
  execFileSync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      '--virtual-time-budget=3000',
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      url,
    ],
    { stdio: 'ignore' },
  );
  console.log(`wrote ${out}`);
}

// ---------- Icons ----------

const svg = readFileSync(join(root, 'assets/icon.svg'), 'utf8');
mkdirSync(join(root, 'static/icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const art = size === 128 ? 96 : size;
  const page = join(scratch, `icon-${size}.html`);
  const style = `display:block;margin:${(size - art) / 2}px`;
  writeFileSync(page, `<!doctype html><body style="margin:0">${svg.replace('<svg ', `<svg width="${art}" height="${art}" style="${style}" `)}</body>`);
  shot(`file://${page}`, join(root, `static/icons/icon-${size}.png`), size, size);
}

// ---------- Small promo tile ----------

const tile = join(scratch, 'tile.html');
writeFileSync(
  tile,
  `<!doctype html><body style="margin:0;width:440px;height:280px;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:0 40px;box-sizing:border-box;background:linear-gradient(160deg,#f6f7fb,#e4eaff);font-family:system-ui,-apple-system,sans-serif;color:#1c1c1f">
    ${svg.replace('<svg ', '<svg width="64" height="64" style="display:block" ')}
    <div style="font-size:34px;font-weight:700;letter-spacing:-.02em">Synclium</div>
    <div style="font-size:16px;color:#4b4b55;line-height:1.4">Sync Helium through a folder or WebDAV server you already have. End-to-end encrypted.</div>
  </body>`,
);
shot(`file://${tile}`, join(root, '../store/promo-tile.png'), 440, 280);

// ---------- Screenshots, through the dev preview (dev/chrome-mock.ts) ----------

const SHOTS = [
  ['1-overview', 'app.html?scenario=healthy#status'],
  ['2-history', 'app.html?scenario=healthy#history'],
  ['3-setup', 'app.html?scenario=setup#setup'],
];
const port = 5199;
const dev = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'scripts/dev.mjs'), '--no-browser'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
try {
  await new Promise((resolve, reject) => {
    dev.stdout.on('data', (chunk) => String(chunk).includes('preview on') && resolve());
    dev.on('exit', (code) => reject(new Error(`dev server exited with ${code}`)));
  });
  const outDir = join(root, '../store/screenshots');
  mkdirSync(outDir, { recursive: true });
  for (const [name, path] of SHOTS) {
    const url = new URL(path, `http://localhost:${port}/`);
    url.searchParams.set('shot', '');
    shot(url.href, join(outDir, `${name}.png`), 1280, 800);
  }
} finally {
  dev.kill('SIGINT'); // dev.mjs stops its tsc --watch on SIGINT
}
