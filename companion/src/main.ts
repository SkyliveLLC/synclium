// helium-sync-companion entry point.
//   (no subcommand)                         native messaging host; Helium passes `chrome-extension://<id>/`
//   apply --user-data-dir <dir>             the apply helper the host spawns; waits for Helium to quit
//   install --extension-id <id> [--user-data-dir <dir>]
//   uninstall [--user-data-dir <dir>]
// Run in a terminal with no subcommand, it prints this usage instead of waiting for Helium's messages.
import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import { parseArgs } from 'node:util';
import { runApplyHelper } from './apply.ts';
import { serve } from './host.ts';
import { install, uninstall } from './install.ts';
import { isHelperRunning } from './lock.ts';
import { fileLog } from './log.ts';
import { companionHome, defaultUserDataDir, launchingUserDataDir } from './paths.ts';

/** How to run this program again: the binary itself, or node plus this script in development. */
const self = (): readonly [string, ...string[]] => {
  const script = process.argv[1];
  return isSea() || script === undefined ? [process.execPath] : [process.execPath, script];
};

async function host(home: string): Promise<void> {
  const log = fileLog(home, 'host');
  const userDataDir = launchingUserDataDir();
  log(`started by ${process.argv.slice(2).join(' ') || '(no origin)'} for ${userDataDir}`);
  const wakeHelper = () => {
    if (isHelperRunning(home, userDataDir)) return;
    const [command, ...args] = self();
    spawn(command, [...args, 'apply', '--user-data-dir', userDataDir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log('spawned apply helper');
  };
  const output = (bytes: Buffer) => new Promise<void>((done, fail) => process.stdout.write(bytes, (error) => (error ? fail(error) : done())));
  await serve({ home, userDataDir, wakeHelper, log }, process.stdin, output);
  log('stdin closed');
}

const USAGE = `helium-sync-companion: the Synclium companion. Helium starts it; you only install it.
  install --extension-id <id> [--user-data-dir <dir>]   register it with Helium
  uninstall [--user-data-dir <dir>]                    unregister it`;

async function main(): Promise<void> {
  const home = companionHome();
  const [command, ...rest] = process.argv.slice(2);
  const options = { 'user-data-dir': { type: 'string' }, 'extension-id': { type: 'string' } } as const;
  switch (command) {
    case 'apply': {
      const { values } = parseArgs({ args: rest, options });
      const userDataDir = values['user-data-dir'];
      if (userDataDir === undefined) throw new Error('apply needs --user-data-dir');
      const log = fileLog(home, 'apply');
      log(`waiting for Helium to quit ${userDataDir}`);
      return runApplyHelper(home, userDataDir, log);
    }
    case 'install': {
      const { values } = parseArgs({ args: rest, options });
      const extensionId = values['extension-id'];
      if (extensionId === undefined) throw new Error('install needs --extension-id <id>');
      if (!isSea()) throw new Error('install registers the built binary: run dist/helium-sync-companion install ...');
      const lines = install({ binary: process.execPath, extensionId, userDataDir: values['user-data-dir'] ?? defaultUserDataDir(), home });
      return void console.log([...lines, 'Installed. Back in Synclium, press Check again.'].join('\n'));
    }
    case 'uninstall': {
      const { values } = parseArgs({ args: rest, options });
      return void console.log(uninstall(values['user-data-dir'] ?? defaultUserDataDir(), home).join('\n'));
    }
    default:
      if (process.stdin.isTTY) {
        process.exitCode = 2;
        return void console.error(USAGE);
      }
      return host(home);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  fileLog(companionHome(), 'main')(`fatal: ${error instanceof Error ? error.stack : message}`);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
