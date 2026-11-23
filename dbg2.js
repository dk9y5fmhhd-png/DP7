process.env.PORT='3224';
require('dotenv').config();
const BASE='http://127.0.0.1:3224';
let jar=new Map();
const ch=()=>[...jar.entries()].map(([k,v])=>`${k}=${v}`).join('; ');
function absorb(res){const l=typeof res.headers.getSetCookie==='function'?res.headers.getSetCookie():(res.headers.get('set-cookie')?[res.headers.get('set-cookie')]:[]);for(const c of l){const[p]=c.split(';');const i=p.indexOf('=');jar.set(p.slice(0,i),p.slice(i+1));}}
async function req(p,o={}){const h={...(o.headers||{})};if(jar.size)h.cookie=ch();const r=await fetch(BASE+p,{...o,headers:h,redirect:'manual'});absorb(r);const t=await r.text();return{status:r.status,text:t,location:r.headers.get('location')};}
const csrf=h=>(h.match(/name="csrf_token" value="([^"]+)"/)||[])[1];
(async()=>{
  require('./src/server'); await new Promise(r=>setTimeout(r,2600));
  const lp=await req('/login');
  await req('/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf_token:csrf(lp.text),login_id:'admin',password:'admin123'}).toString()});
  const up=await req('/upload');
  console.log('upload status:',up.status);
  const m=up.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const p=up.text.match(/<p class="sub"[^>]*>([\s\S]*?)<\/p>/);
  console.log('heading:', m?m[1].trim():'-');
  console.log('message:', p?p[1].trim().slice(0,400):'-');
  process.exit(0);
})();
