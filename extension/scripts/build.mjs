// Compiles src/ with tsc and copies static/ beside it. No bundler: Chromium loads ES modules natively.
//   node scripts/build.mjs          release -> dist/      (folder-store.ts: the folder the user picks)
//   node scripts/build.mjs --dev    dev     -> dist-dev/  (dev-store.ts: chrome.storage.local as the "folder")
// The release check fails the build if any dev-only module reached dist/, for example through a stray import.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dev = process.argv.includes('--dev');
const root = new URL('..', import.meta.url).pathname;
const out = join(root, dev ? 'dist-dev' : 'dist');
const DEV_ONLY = ['dev-store.js', 'worker-dev.js'];

rmSync(out, { recursive: true, force: true });
execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(root, dev ? 'tsconfig.build-dev.json' : 'tsconfig.build.json')], { stdio: 'inherit' });
for (const name of readdirSync(join(root, 'static'))) if (name !== 'manifest.json') cpSync(join(root, 'static', name), join(out, name));

const manifest = JSON.parse(readFileSync(join(root, 'static/manifest.json'), 'utf8'));
if (dev) {
  manifest.name = `${manifest.name} (dev store)`;
  manifest.background.service_worker = 'worker-dev.js';
  // Scripted e2e runs cannot click a permission prompt, so the dev build holds its optional permissions up front.
  manifest.permissions = [...manifest.permissions, ...(manifest.optional_permissions ?? [])];
  delete manifest.optional_permissions;
} else {
  const leaked = DEV_ONLY.filter((name) => existsSync(join(out, name)));
  if (leaked.length > 0) {
    rmSync(out, { recursive: true, force: true }); // leave nothing loadable behind
    throw new Error(`release build contains dev-only modules: ${leaked.join(', ')}`);
  }
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${dev ? 'dev' : 'release'} extension in ${out}`);
