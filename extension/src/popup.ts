// popup.html: one sentence of status, [Sync now], and the one button the status calls for.
import { SHOWN_KEY, ask, primaryAction, readShown, shownFrom, statusSentence, viewOf, type Shown } from './ui.ts';

function byId<E extends HTMLElement>(id: string, type: { new (): E }): E {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`popup.html lacks #${id}`);
  return found;
}

const status = byId('status', HTMLParagraphElement);
const sync = byId('sync', HTMLButtonElement);
const action = byId('action', HTMLButtonElement);
const open = byId('open', HTMLButtonElement);

let shown: Shown = await readShown();

function render(): void {
  const view = viewOf(shown);
  status.textContent = statusSentence(view, Date.now());
  sync.hidden = view.kind === 'setup';
  const next = primaryAction(view);
  action.hidden = next === null;
  if (next === null) return;
  action.textContent = next.label;
  action.onclick = () => (next.opens === null ? void ask({ kind: 'sync-now' }) : void chrome.tabs.create({ url: chrome.runtime.getURL(next.opens) }));
}

sync.onclick = async () => {
  sync.disabled = true;
  sync.textContent = 'Syncing';
  await ask({ kind: 'sync-now' });
};
open.onclick = () => void chrome.tabs.create({ url: chrome.runtime.getURL('app.html#status') });

chrome.storage.local.onChanged.addListener((changes) => {
  const change = changes[SHOWN_KEY];
  if (change === undefined) return;
  shown = shownFrom(change.newValue);
  sync.disabled = false;
  sync.textContent = 'Sync now';
  render();
});
setInterval(render, 30_000);
render();
