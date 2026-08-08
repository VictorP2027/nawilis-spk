import { MongoClient } from 'mongodb';
const BASE = process.env.TURBOLY_BASE_URL ?? 'https://sandbox.turboly.com';
const jarOf=(r)=>(r.headers.getSetCookie?.()??[]).map(x=>x.split(';')[0]);
const merge=(...ls)=>{const m=new Map();for(const l of ls)for(const p of l){const[k,...v]=p.split('=');if(k&&v.length)m.set(k,v.join('='));}return [...m].map(([k,v])=>`${k}=${v}`).join('; ');};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const r1=await fetch(`${BASE}/users/sign_in`,{redirect:'manual'});const pre=jarOf(r1);
const tok=/name="authenticity_token"[^>]*value="([^"]+)"/.exec(await r1.text())?.[1]??'';
const r2=await fetch(`${BASE}/users/sign_in`,{method:'POST',redirect:'manual',headers:{cookie:merge(pre),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({'user[email]':'phisitkul.victor2@gmail.com','user[password]':'Naw123',authenticity_token:tok,commit:'Login'}).toString()});
let ck=merge(pre,jarOf(r2));
const r3=await fetch(r2.headers.get('location')??`${BASE}/dashboard`,{headers:{cookie:ck},redirect:'manual'});ck=merge(ck.split('; '),jarOf(r3));
const html=await (await fetch(`${BASE}/vehicles/new`,{headers:{cookie:ck}})).text();
const sel=/<select[^>]*id="vehicle-make-select"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1]??'';
const makes=[...sel.matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/g)].map(m=>({v:m[1],t:m[2].trim()}));

// expected total per NAME = sum of that name's rows' totals
const expect = {};
for (const mk of makes) {
  let total = null;
  for (let a=0;a<4;a++){
    const r=await fetch(`${BASE}/lookup/vehicle_models?search_term=&vehicle_type=&vehicle_make=${mk.v}&page=1&page_limit=1`,{headers:{cookie:ck,accept:'application/json'}});
    if(r.ok){ const j=await r.json().catch(()=>null); if(j){ total=j.total??0; break; } }
    await sleep(800*(a+1));
  }
  if (total===null) { console.log(`⚠ could not read total for ${mk.t}#${mk.v}`); continue; }
  expect[mk.t]=(expect[mk.t]??0)+total;
  await sleep(120);
}
const c=new MongoClient(process.env.MONGODB_URI); await c.connect();
const col=c.db('spk').collection('vehicle_models_map');
const by=(await col.findOne({_id:'byMake'}))?.byMake??{};
const short=Object.entries(expect).filter(([n,tot])=>(by[n]??[]).length<tot).map(([n,tot])=>({n,have:(by[n]??[]).length,tot}));
console.log(`audit: ${Object.keys(expect).length} makes · expected ${Object.values(expect).reduce((a,b)=>a+b,0)} models · mirror ${Object.values(by).reduce((s,a)=>s+a.length,0)}`);
console.log(short.length ? 'SHORT: '+short.map(s=>`${s.n} ${s.have}/${s.tot}`).join(' · ') : '✅ every make complete');

// refetch the short ones
const idsByName={}; for (const m of makes) (idsByName[m.t]??=[]).push(m.v);
for (const s of short) {
  const fresh=new Set(by[s.n]??[]);
  for (const id of idsByName[s.n]??[]) {
    let total=null; const seen=new Set(); const out=[];
    for (let pg=1;pg<=40;pg++){
      let j=null;
      for(let a=0;a<5;a++){
        const r=await fetch(`${BASE}/lookup/vehicle_models?search_term=&vehicle_type=&vehicle_make=${id}&page=${pg}&page_limit=100`,{headers:{cookie:ck,accept:'application/json'}});
        if(r.ok){ j=await r.json().catch(()=>null); if(j) break; }
        await sleep(1000*(a+1));
      }
      if(!j) break;
      if(total===null) total=j.total??null;
      const list=(j.vehicle_models??[]).map(m=>m.name).filter(n=>n&&!seen.has(n));
      if(list.length===0) break;
      for(const n of list){seen.add(n); fresh.add(n);}
      out.push(...list);
      if(total!==null&&out.length>=total) break;
      await sleep(400);
    }
    await sleep(800);
  }
  by[s.n]=[...fresh];
  console.log(`  refetched ${s.n}: ${by[s.n].length}/${s.tot}`);
}
if (short.length) await col.updateOne({_id:'byMake'},{$set:{byMake:by,syncedAt:new Date().toISOString()}});
console.log('final total:', Object.values(by).reduce((sm,a)=>sm+a.length,0));
await c.close();
