// Faithful re-run of the plugin's parseReferences (real bundled TS) plus a port of
// SkillParser.resolveRefPath's 3 strategies against a given vault file set.
const fs=require("fs"), path=require("path");
const {parseReferences}=require(process.argv[2]);
const vaultRoot=process.argv[3]; const mode=process.argv[4]; // "flat" or "classic"
function walk(d,acc=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name.startsWith("."))continue;const p=path.join(d,e.name);
  let st; try{st=fs.statSync(p);}catch{continue;} if(st.isDirectory())walk(p,acc); else acc.push(path.relative(vaultRoot,p).split(path.sep).join("/"));} return acc;}
const files=walk(vaultRoot); const fileSet=new Set(files);
const skillFiles=files.filter(f=> mode==="flat" ? (path.dirname(f)==="skills"&&f.endsWith(".md")) : path.basename(f)==="SKILL.md");
const resolve=(ref,dir)=>{const s1=dir?`${dir}/${ref}`:ref; if(fileSet.has(s1))return s1; if(fileSet.has(ref))return ref; const i=ref.indexOf("/"); if(i!==-1){const s=ref.slice(i+1); if(fileSet.has(s))return s;} return null;};
let out={mode,vaultFiles:files.length,skillNodes:skillFiles.length,edges:[],unresolved:{},dropped:{}};
for(const f of skillFiles){const text=fs.readFileSync(path.join(vaultRoot,f),"utf8"); const {relativePaths,absolutePaths}=parseReferences(text); const dir=path.dirname(f)==="."?"":path.dirname(f);
  const src= mode==="flat"? path.basename(f,".md") : path.dirname(f);
  for(const r of relativePaths){const t=resolve(r,dir); if(t){out.edges.push([src,t]);} else if(!/[[\]{}]/.test(r)&&!/YYYY/.test(r)){(out.unresolved[src]??=[]).push(r);} else {(out.dropped[src]??=[]).push(r);} }
  if(absolutePaths.length)(out.unresolved[src]??=[]).push(...absolutePaths.map(a=>"ABS:"+a));}
console.log(JSON.stringify(out,null,1));
