const swStart = Date.now();
const port = chrome.runtime.connectNative('dev.p2.sync');
const keysDeep = (n) => ({ keys: Object.keys(n), node: { ...n, children: n.children ? `[${n.children.length}]` : undefined } });
const handlers = {
  async getTree() { return chrome.bookmarks.getTree(); },
  async create({ title, url }) { return chrome.bookmarks.create({ parentId: '1', title, url }); },
  async createWithId({ title, url }) {
    try { return await chrome.bookmarks.create({ parentId: '1', title, url, id: 'fixed-id-123' }); } catch (e) { return { error: String(e) }; }
  },
  async nodeKeys() {
    const [root] = await chrome.bookmarks.getTree();
    const bar = root.children[0];
    return { root: keysDeep(root), bar: keysDeep(bar), leaf: bar.children?.[0] && keysDeep(bar.children[0]) };
  },
  async ping({ n }) { return { pong: n, t: Date.now(), swStart }; },
  async historyAdd({ url }) {
    let extra;
    try { await chrome.history.addUrl({ url, visitTime: 0 }); extra = 'visitTime accepted'; } catch (e) { extra = 'visitTime rejected: ' + e; }
    await chrome.history.addUrl({ url });
    const visits = await chrome.history.getVisits({ url });
    const items = await chrome.history.search({ text: url, startTime: 0 });
    return { extra, visits, items, now: Date.now() };
  },
  async mgmt() { return (await chrome.management.getAll()).map(e => ({ id: e.id, name: e.name, type: e.type, installType: e.installType, enabled: e.enabled })); },
  async sessions() { try { return { devices: await chrome.sessions.getDevices(), recent: (await chrome.sessions.getRecentlyClosed()).length }; } catch (e) { return { error: String(e) }; } },
  async probe() {
    return Object.fromEntries(['passwordsPrivate', 'loginState', 'autofillPrivate', 'readingList', 'tabGroups', 'sidePanel', 'cookies', 'storage', 'sessions', 'bookmarks', 'history'].map(k => [k, typeof chrome[k]]));
  },
  async tabs() { return (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url, windowId: t.windowId })); },
};
port.onMessage.addListener(async (msg) => {
  try { port.postMessage({ reqId: msg.reqId, cmd: msg.cmd, ok: true, result: await handlers[msg.cmd](msg) }); }
  catch (e) { port.postMessage({ reqId: msg.reqId, cmd: msg.cmd, ok: false, error: String(e) }); }
});
port.onDisconnect.addListener(() => console.log('disconnected', chrome.runtime.lastError?.message));
port.postMessage({ hello: chrome.runtime.id, t: Date.now() });
