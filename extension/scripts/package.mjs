// `npm run package`: the release build, zipped for a Chrome Web Store upload as synclium-<version>.zip.
// Bump `version` in static/manifest.json first: the store rejects an upload whose version it has already seen.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync(join(root, 'dist/manifest.json'), 'utf8'));
const zip = join(root, `synclium-${version}.zip`);
rmSync(zip, { force: true });
// -X drops macOS extended attributes; the manifest sits at the zip's root, as the store requires.
execFileSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: join(root, 'dist'), stdio: 'inherit' });
console.log(`packaged ${zip}`);
