// node writebm.mjs <file> <mode: good|bad> <name> <url> <guid> [append]
import fs from "node:fs"; import {checksum} from "./checksum.mjs";
const [file,mode,name,url,guid,append]=process.argv.slice(2);
const folder=(id,name,guid)=>({children:[],date_added:"13401000000000000",date_last_used:"0",date_modified:"0",guid,id,name,type:"folder"});
let b = append && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,"utf8")) : {roots:{
  bookmark_bar:folder("1","Bookmarks bar","0bc5d13f-2cba-5d74-951f-3f233fe6c908"),
  other:folder("2","Other bookmarks","82b081ec-3dd3-529c-8475-ab6c344590dd"),
  synced:folder("3","Mobile bookmarks","4cf2e351-0e85-532b-bb37-df045d8f8d0f")},version:1};
const ids=[]; const walk=n=>{ids.push(+n.id);(n.children||[]).forEach(walk)}; Object.values(b.roots).forEach(walk);
b.roots.bookmark_bar.children.push({date_added:"13300000000000000",date_last_used:"0",guid,id:String(Math.max(...ids)+1),name,type:"url",url});
b.checksum = mode==="bad" ? "00000000000000000000000000000000" : checksum(b);
fs.writeFileSync(file, JSON.stringify(b,null,3));
console.log("wrote", file, "checksum", b.checksum);
