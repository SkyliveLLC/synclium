import { put, get, probe, log } from './idb.js';
const show = async () => { const { logs = [] } = await chrome.storage.local.get('logs'); document.getElementById('out').textContent = logs.join('\n'); };
document.getElementById('pick').onclick = async () => {
  try { const h = await window.showDirectoryPicker({ id: 'helium-sync', mode: 'readwrite' }); await put('dir', h); await log('page', `picked ${h.name}`); await probe('page-after-pick'); }
  catch (e) { await log('page', `pick failed ${e.name}: ${e.message}`); }
  show();
};
document.getElementById('probe').onclick = async () => { await probe('page'); chrome.runtime.sendMessage('probe'); setTimeout(show, 1000); };
probe('page-load').then(show);
document.getElementById('regrant').onclick = async () => {
  const h = await get('dir');
  if (!h) { await log('page', 'regrant: no handle'); return show(); }
  try { const r = await h.requestPermission({ mode: 'readwrite' }); await log('page', `requestPermission=${r}`); await probe('page-after-regrant'); }
  catch (e) { await log('page', `requestPermission threw ${e.name}: ${e.message}`); }
  show();
};
