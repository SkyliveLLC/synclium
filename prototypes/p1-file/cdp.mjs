// tiny CDP client: node cdp.mjs <expr-on-bookmarks-page> | node cdp.mjs nav <url>
const PORT=9333;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function targets(){ for(let i=0;i<60;i++){ try{ return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); }catch{ await sleep(500);} } throw new Error("no cdp"); }
function connect(ws){ return new Promise((res)=>{ const s=new WebSocket(ws); let id=0; const pend=new Map();
  s.onmessage=e=>{const m=JSON.parse(e.data); if(pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
  s.onopen=()=>res({send:(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);s.send(JSON.stringify({id:i,method,params}));}),close:()=>s.close()}); }); }
export async function page(urlPrefix, openUrl){
  let t=(await targets()).find(t=>t.type==="page"&&t.url.startsWith(urlPrefix));
  if(!t){ t=await (await fetch(`http://127.0.0.1:${PORT}/json/new?${openUrl}`,{method:"PUT"})).json(); await sleep(1500); }
  return connect(t.webSocketDebuggerUrl);
}
export async function evalBm(expr){
  const c=await page("chrome://bookmarks","chrome://bookmarks/");
  const r=await c.send("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true}); c.close();
  return r.result?.result?.value ?? r;
}
if(process.argv[2]==="nav"){ const t=await (await fetch(`http://127.0.0.1:${PORT}/json/new?${process.argv[3]}`,{method:"PUT"})).json(); console.log("opened",t.url); await sleep(3000); }
else if(process.argv[2]) console.log(JSON.stringify(await evalBm(process.argv[2]),null,1));
