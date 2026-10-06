import {createHash} from "node:crypto"; import fs from "node:fs";
export function checksum(b){
  const h=createHash("md5");
  const walk=n=>{
    h.update(n.id,"utf8"); h.update(Buffer.from(n.name,"utf16le"));
    if(n.type==="url"){h.update("url");h.update(n.url,"utf8");}
    else {h.update("folder"); for(const c of n.children) walk(c);}
  };
  for(const k of ["bookmark_bar","other","synced"]) walk(b.roots[k]);
  return h.digest("hex");
}
if (import.meta.main && process.argv[2]) { const b=JSON.parse(fs.readFileSync(process.argv[2],"utf8")); console.log("computed",checksum(b),"\nstored  ",b.checksum); }
