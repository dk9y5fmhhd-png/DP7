process.env.PORT='3330';require('dotenv').config();
const puppeteer=require('puppeteer-core');const bcrypt=require('bcryptjs');const path=require('path');
const OUT='/tmp/.scratch/dp7shots';const BASE='http://127.0.0.1:3330';
const D=require('../src/lib/dates');
require('../src/server');
setTimeout(async()=>{
  const db=require('../src/db');
  await db.query("DELETE FROM users WHERE login_id='tgc'");
  const cr=await db.query(`INSERT INTO users (name,login_id,password_hash,role,page_access,require_approval,daily_target)
    VALUES ('kamal','tgc',$1,'admin',$2,FALSE,40) RETURNING id`,
    [await bcrypt.hash('tgc1234',10),['mycalls','customers','priority']]);
  const cid=cr.rows[0].id;
  const names=[];
  await db.query("DELETE FROM customers WHERE username LIKE 'TgShot%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'TgShot%'");
  for(let i=1;i<=60;i++){
    const u='TgShot'+String(i).padStart(3,'0'); names.push(u);
    await db.query(`INSERT INTO deposits (play_date,username,mobile,amount,status,source)
      VALUES ($1,$2,$3,$4,'successful','test')`,[D.addDays(D.todayISO(),-25),u,'9'+String(100000000+i),500+i*20]);
  }
  await require('../src/lib/customers').syncCustomers();
  await db.query('UPDATE customers SET assigned_to=$1 WHERE username = ANY($2::text[])',[cid,names]);
  // 14 kaam ho chuke
  const D2=require('../src/lib/dates');
  for(let i=0;i<14;i++){
    await db.query(`INSERT INTO followups (username,action_type,action_date,response,next_action,follow_up_on,caller_id,created_by)
      VALUES ($1,'No Answer',$2,'demo','Retry queue',$3,$4,$4)`,
      [names[i],D2.todayISO(),D2.addDays(D2.todayISO(),1),cid]);
  }
  const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
  const p=await b.newPage(); await p.setViewport({width:1500,height:1100});
  await p.goto(BASE+'/login',{waitUntil:'networkidle0'});
  await p.type('input[name="login_id"]','tgc'); await p.type('input[name="password"]','tgc1234');
  await Promise.all([p.waitForNavigation({waitUntil:'networkidle0'}),p.click('button[type="submit"]')]);
  await p.goto(BASE+'/calling/my',{waitUntil:'networkidle0'});
  await new Promise(r=>setTimeout(r,300));
  await p.screenshot({path:path.join(OUT,'v41-target.png')});
  console.log('✓ target');

  // admin view
  const ctx=await b.createBrowserContext(); const a=await ctx.newPage();
  await a.setViewport({width:1500,height:1000});
  await a.goto(BASE+'/login',{waitUntil:'networkidle0'});
  await a.type('input[name="login_id"]','admin'); await a.type('input[name="password"]','admin123');
  await Promise.all([a.waitForNavigation({waitUntil:'networkidle0'}),a.click('button[type="submit"]')]);
  await a.goto(BASE+'/calling/due',{waitUntil:'networkidle0'});
  await a.screenshot({path:path.join(OUT,'v41-due.png')});
  console.log('✓ due');
  await a.goto(BASE+'/users',{waitUntil:'networkidle0'});
  await a.screenshot({path:path.join(OUT,'v41-users.png')});
  console.log('✓ users');

  await b.close();
  await db.query("DELETE FROM deposits WHERE username LIKE 'TgShot%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'TgShot%'");
  await db.query("DELETE FROM users WHERE login_id='tgc'");
  await db.pool.end();process.exit(0);
},2700);
