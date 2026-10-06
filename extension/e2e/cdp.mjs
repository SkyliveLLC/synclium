// Minimal CDP client over one browser websocket with flattened target sessions.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function launch({ profile, port, ext, log }) {
  const child = spawn('/Applications/Helium.app/Contents/MacOS/Helium', [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--load-extension=${ext}`,
  ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
  child.unref();
  return child.pid;
}

export async function connect(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return new Browser(v.webSocketDebuggerUrl);
    } catch { await sleep(500); }
  }
  throw new Error(`no CDP on ${port}`);
}

export class Browser {
  #ws; #id = 0; #pending = new Map(); listeners = [];
  constructor(url) {
    this.#ws = new WebSocket(url);
    this.ready = new Promise((r) => (this.#ws.onopen = r));
    this.#ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined) {
        const p = this.#pending.get(m.id);
        this.#pending.delete(m.id);
        if (m.error) p?.reject(new Error(`${p.method}: ${m.error.message}`)); else p?.resolve(m.result);
      } else for (const l of this.listeners) l(m);
    };
  }
  async call(method, params = {}, sessionId) {
    await this.ready;
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.#ws.close(); }

  async targets() { return (await this.call('Target.getTargets')).targetInfos; }

  async waitTarget(pred, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = (await this.targets()).find(pred);
      if (t) return t;
      await sleep(300);
    }
    throw new Error('target not found');
  }

  /** Attach and collect errors: exceptions, console.error, and Log errors. */
  async attach(targetId, label) {
    const { sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true });
    const errors = [];
    const logs = [];
    this.listeners.push((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') errors.push(`${label} exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map((a) => a.value ?? a.description).join(' ');
        logs.push(`${label} console.${m.params.type}: ${text}`);
        if (m.params.type === 'error') errors.push(`${label} console.error: ${text}`);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`${label} log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
    });
    await this.call('Runtime.enable', {}, sessionId);
    await this.call('Log.enable', {}, sessionId).catch(() => {});
    const self = this;
    return {
      sessionId, errors, logs,
      async eval(expression) {
        const r = await self.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
        if (r.exceptionDetails) throw new Error(`${label} eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value;
      },
      async shot(path) {
        const r = await self.call('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(path, Buffer.from(r.data, 'base64'));
        return path;
      },
    };
  }

  async openPage(url, label) {
    const { targetId } = await this.call('Target.createTarget', { url: 'about:blank' });
    const page = await this.attach(targetId, label);
    await this.call('Page.enable', {}, page.sessionId);
    await this.call('Emulation.setDeviceMetricsOverride', { width: label.includes('popup') ? 340 : 900, height: label.includes('popup') ? 200 : 900, deviceScaleFactor: 1, mobile: false }, page.sessionId);
    await this.call('Page.navigate', { url }, page.sessionId);
    await sleep(1500);
    return { ...page, targetId };
  }
}

export async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what} (last ${JSON.stringify(last)})`);
}
