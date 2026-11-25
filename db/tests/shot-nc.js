process.env.PORT='3310';require('dotenv').config();
const puppeteer=require('puppeteer-core');const fs=require('fs');const path=require('path');
const OUT='/tmp/.scratch/dp7shots';const BASE='http://127.0.0.1:3310';
const iso=(o)=>{const d=new Date();d.setUTCDate(d.getUTCDate()-o);return d.toISOString().slice(0,10);};
require('../src/server');
setTimeout(async()=>{
  const db=require('../src/db');
  const ym=iso(0).slice(0,7);
  const names=[];
  await db.query("DELETE FROM customers WHERE username LIKE 'ShotNC%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'ShotNC%'");
  const plan=[[1,4],[2,2],[3,6],[4,1],[5,3],[8,5],[9,2],[12,7],[15,3],[16,1],[18,4],[20,2],[22,5],[23,3],[24,2],[25,4],[26,1]];
  let n=0;
  for(const [day,count] of plan) for(let i=0;i<count;i++){
    n++; const u=`ShotNC${String(n).padStart(3,'0')}`; names.push(u);
    await db.query(`INSERT INTO deposits (play_date,username,mobile,amount,status,source)
      VALUES ($1,$2,$3,$4,'successful','test')`,[`${ym}-${String(day).padStart(2,'0')}`,u,'98765'+String(43210+n),500+n*10]);
  }
  await require('../src/lib/customers').syncCustomers();
  const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:'new',
    args:['--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
  const p=await b.newPage(); await p.setViewport({width:1500,height:1200});
  await p.goto(BASE+'/login',{waitUntil:'networkidle0'});
  await p.type('input[name="login_id"]','admin'); await p.type('input[name="password"]','admin123');
  await Promise.all([p.waitForNavigation({waitUntil:'networkidle0'}),p.click('button[type="submit"]')]);
  await p.goto(BASE+'/new-clients',{waitUntil:'networkidle0'});
  await new Promise(r=>setTimeout(r,400));
  await p.screenshot({path:path.join(OUT,'v40-newclients.png')});
  console.log('✓ grid');
  await p.goto(BASE+'/new-clients?m='+ym+'&d=12',{waitUntil:'networkidle0'});
  await new Promise(r=>setTimeout(r,300));
  await p.screenshot({path:path.join(OUT,'v40-day.png')});
  console.log('✓ day');
  await p.setViewport({width:420,height:900,isMobile:true});
  await p.goto(BASE+'/new-clients',{waitUntil:'networkidle0'});
  await p.screenshot({path:path.join(OUT,'v40-mobile.png')});
  console.log('✓ mobile');
  await b.close();
  await db.query("DELETE FROM customers WHERE username LIKE 'ShotNC%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'ShotNC%'");
  await db.pool.end();process.exit(0);
},2700);
