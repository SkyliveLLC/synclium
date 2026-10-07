// Build dist/helium-sync-companion: esbuild bundles src/main.ts (and the contract it imports) into one CommonJS
// file, Node's single executable application support wraps it in a copy of this node binary, and an ad-hoc
// signature lets macOS run it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const bundle = join(dist, 'companion.cjs');
const blob = join(dist, 'sea-prep.blob');
const binary = join(dist, 'helium-sync-companion');
const run = (command: string, args: readonly string[]) => execFileSync(command, args, { stdio: 'inherit', cwd: root });

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
await build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: bundle, logLevel: 'warning' });

const seaConfig = join(dist, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

copyFileSync(process.execPath, binary);
run('codesign', ['--remove-signature', binary]);
run(join(root, 'node_modules/.bin/postject'), [binary, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--macho-segment-name', 'NODE_SEA']);
run('codesign', ['--sign', '-', binary]);
console.log(`built ${binary}`);
