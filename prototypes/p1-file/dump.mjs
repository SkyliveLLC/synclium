import fs from "node:fs"; const b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const walk=(n,d)=>{console.log("  ".repeat(d)+[n.id,n.type,n.guid,n.date_added,n.name,n.url||""].join(" | "));(n.children||[]).forEach(c=>walk(c,d+1))};
for(const k in b.roots) walk(b.roots[k],0); console.log("top keys",Object.keys(b));
