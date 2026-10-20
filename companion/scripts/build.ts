// Build dist/helium-sync-companion (.exe on Windows) for the system it runs on: esbuild bundles src/main.ts (and the
// contract it imports) into one CommonJS file, and Node's single executable application support wraps it in a copy
// of this node binary. On macOS an ad-hoc signature lets it run. It also writes the same binary under its release
// name (companionAsset), which release-companion.yml uploads.
// Run it with an official Node build: one linked against a shared libnode (Homebrew's) has nothing to inject into.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { companionAsset } from '../../extension/src/profile-mode.ts';
import { binaryFile, currentOs } from '../src/paths.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const bundle = join(dist, 'companion.cjs');
const blob = join(dist, 'sea-prep.blob');
const os = currentOs();
const binary = join(dist, binaryFile(os));
const run = (command: string, args: readonly string[]) => execFileSync(command, args, { stdio: 'inherit', cwd: root });

// chrome.runtime.getPlatformInfo's names, which the extension uses to pick a download.
const chromeOs = { darwin: 'mac', linux: 'linux', win32: 'win' }[os];
const chromeArch = process.arch === 'x64' ? 'x86-64' : process.arch;
const asset = companionAsset(chromeOs, chromeArch);
if (asset === null) throw new Error(`no release name for ${os} ${process.arch}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
await build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: bundle, logLevel: 'warning' });

const seaConfig = join(dist, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

copyFileSync(process.execPath, binary);
const postject = [join(root, 'node_modules/postject/dist/cli.js'), binary, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (os === 'darwin') {
  run('codesign', ['--remove-signature', binary]);
  run(process.execPath, [...postject, '--macho-segment-name', 'NODE_SEA']);
  run('codesign', ['--sign', '-', binary]);
} else {
  run(process.execPath, postject);
}
copyFileSync(binary, join(dist, asset));
console.log(`built ${binary} (release name ${asset})`);
