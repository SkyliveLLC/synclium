// Injected into chrome://settings: promise wrapper over chrome.send / cr.webUIResponse.
window.__p = window.__p || {};
if (!window.__wrapped) { const orig = cr.webUIResponse; cr.webUIResponse = (id, ok, resp) => { if (window.__p[id]) { window.__p[id]({ ok, resp }); delete window.__p[id]; } else orig(id, ok, resp); }; window.__wrapped = true; }
window.sendP = (msg, ...args) => new Promise((res) => { const id = 'p9_' + Math.random(); window.__p[id] = res; chrome.send(msg, [id, ...args]); setTimeout(() => res({ timeout: msg }), 4000); });
