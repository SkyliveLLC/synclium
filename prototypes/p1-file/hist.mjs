import {DatabaseSync} from "node:sqlite"; import fs from "node:fs";
const P="/tmp/helium-sync-scratch/p1-file/profile/Default/History";
const q=`select u.url,u.title,u.visit_count,v.visit_time from visits v join urls u on u.id=v.url order by v.id desc limit 5`;
function attempt(label, open){ try{ const db=open(); const rows=db.prepare(q).all(); console.log(label,"OK", "journal_mode="+db.prepare("pragma journal_mode").get().journal_mode, JSON.stringify(rows.map(r=>r.url))); db.close(); } catch(e){ console.log(label,"FAIL",e.code||"",e.errcode??"",e.message); } }
attempt("readOnly path      ", ()=>new DatabaseSync(P,{readOnly:true,readBigInts:true}));
attempt("immutable URI      ", ()=>new DatabaseSync(`file:${P}?immutable=1`,{readOnly:true,readBigInts:true}));
attempt("mode=ro URI        ", ()=>new DatabaseSync(`file:${P}?mode=ro`,{readOnly:true,readBigInts:true}));
fs.copyFileSync(P,"/tmp/helium-sync-scratch/p1-file/History.copy");
attempt("copy (main only)   ", ()=>new DatabaseSync("/tmp/helium-sync-scratch/p1-file/History.copy",{readOnly:true,readBigInts:true}));
if (process.argv[2]==="schema"){ const db=new DatabaseSync("/tmp/helium-sync-scratch/p1-file/History.copy",{readOnly:true,readBigInts:true});
  for(const t of ["urls","visits"]) console.log(t+":", db.prepare(`pragma table_info(${t})`).all().map(c=>c.name).join(", ")); }
