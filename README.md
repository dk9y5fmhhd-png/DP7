# DP7 — naya system (Node.js + PostgreSQL)

Client deposits, retention reports aur follow-ups ka poora admin system — purane PHP version ki jagah, scratch se likha hua.

> **Ek line me:** `npm run migrate` → `npm start` → login → data daalna shuru.


---

## 0. v3 — Retention CRM (spec ke hisaab se)

Ye version aapke ChatGPT spec par bana hai: 7-day rule, VIP by count, P1/P2/P3 priority,
caller assignment, remark system, do-tarah ka daily Excel upload aur TeleCMI click-to-call.

### Niyam jo code me lage hue hain

| Cheez | Kaise chalta hai |
|---|---|
| **Status** | Pehla deposit → **New** · 7 din ke andar dobara → **Active** · 7 din tak koi deposit nahi → **Inactive** · Inactive ne dobara kiya → **Reactivated** |
| **Countdown** | Har successful deposit par 7 din ka count phir se shuru |
| **VIP** | Sirf **successful deposit ke COUNT** se — 25+ VIP · 51+ Premium VIP · 101+ High Value VIP. Amount se nahi. Ek baar VIP bana to permanent (inactive hone par bhi VIP rahega) |
| **Priority** | **P1** VIP inactive + recently inactive (≤14 din) · **P2** normal inactive + naya customer · **P3** callback pending · **P4** active (call ki zaroorat nahi) |
| **Assignment** | Ek customer sirf **ek** caller ke paas. Bulk assign bilkul filter par bhi ho sakta hai |
| **Mobile** | Caller ko masked (`••••0914`) — sirf admin ko poora number. Call button se dial |
| **Do Not Contact** | Aage kisi calling list me nahi aayega |


### Deposit count ka matlab (zaroori)

`Deposits` column = us customer ki **kitni deposit rows** hain. Ek row = ek deposit.

| File | Kya hota hai |
|---|---|
| Ek customer ki **ek hi row**, jisme lifetime total (₹30,000) | count = **1**, Level = total se (₹30,000 → Level 4) |
| Har deposit ki **alag row** (₹500, ₹700, ₹900…) | count = **3**, aur 25+ par VIP |

Summary (total) file se VIP kabhi nahi banega — VIP ke liye transaction-wise rows chahiye.

**Same din ki do deposits** bhi alag rows hoti hain (v3.1 se) — pehle ek merge ho jati thi.
Duplicate protection sirf **transaction ID** par hai.

Galat file chali jaye to **Daily Upload → Galat upload hatayein** se pehle saaf karein
(`DELETE` likhna padta hai), phir sahi file upload karein — customer master khud dobara ban jayega.

### Naye pages

| Page | Kaam |
|---|---|
| **Customers** | Customer master — status, VIP, priority, caller, last remark. Filter + bulk assign |
| **Calling List** | P1/P2/P3 ke hisaab se aaj kisko call karna hai (admin view) |
| **My Calls** | Caller ka apna dashboard — sirf assigned customers, masked number, call + remark |
| **Call Log** | Kaun, kab, kisko call kiya — TeleCMI ya manual |
| **Daily Upload** | A. naye customers (username + mobile) · B. deposit transactions (txn id, amount, status) |

### Remarks aur unka next action

| Remark | System aage kya karta hai |
|---|---|
| Interested | Follow-up schedule |
| Will Deposit | Follow-up priority |
| Not Interested | Low priority / review |
| No Answer | Retry queue |
| Number Not Reachable | Retry later |
| Already Active | Activity verification |
| Wrong Number | Data correction |
| Do Not Contact | Customer suppress (DNC) |

### TeleCMI click-to-call

**Settings → TeleCMI** me App ID, Secret aur Agent number daal dein.
Uske baad **Call** button seedha agent ke phone par call laga dega — customer ka number caller ko dikhega nahi.
Keys nahi hain to Call button sirf call log karta hai (manual dial) — system band nahi hota.

### Auto-migrate (ye dhyan dein)

Ab **server start hote hi** schema, settings aur customer sync khud ho jaate hain.
Matlab naye deployment par Console me `npm run migrate` chalane ki zaroorat nahi —
`✓ bootstrap complete` log me dikh jayega.

---

## 1. Kya-kya andar hai

| Page | Kaam |
|---|---|
| **Dashboard** | Total/active/inactive clients, habit-group cards, 14-din activity trend, follow-up breakdown |
| **Add Data** | Excel/CSV upload (multi-date), ya seedha paste; recent days; T-PIN se din delete |
| **Client Reports** | Kis client ne us din deposit nahi kiya — level, duplicate number, remark, follow-up ke saath |
| **Level Report** | Lifetime deposits se ranking, 9 tarah ki sorting, active/inactive |
| **Daily / Weekly / By Weekly / Monthly** | Habit ke hisaab se cohort — kaun "gone quiet" hua |
| **Follow-ups** | Sab calls ka log, search + action filter |
| **Users** | Staff accounts, role (Admin / Super Admin), page-level access, unlock |
| **Settings** | Level bands, active window, retention lookback, cohort limits, delete T-PIN |
| **Security** | Apna password, 2FA (authenticator app), activity log |
| **Backup & Export** | Deposits / clients / follow-ups CSV, settings JSON |

Baaki: login throttle (5 galat password = 15 min lock), CSRF protection, session DB me, har action ka audit log, mobile-friendly layout, print/CSV export.

`screenshots/` folder me asli chalte hue system ke screenshots hain (demo data ke saath) — deploy karne se pehle dekh lijiye.

---

## 2. Local chalana (optional)

```bash
cp .env.example .env          # DATABASE_URL apna daalein
npm install
npm run migrate               # tables + level bands + pehla admin
npm start                     # http://localhost:3000
```

Demo data dekhna ho (sirf testing ke liye — production me **kabhi** na chalayein):

```bash
FORCE_DEMO=1 node scripts/demo-data.js 500 70
```

Tests:

```bash
npm test                      # 46 checks: sab pages, imports, exports, 2FA
node tests/permissions.js     # 13 checks: page-access rules
```

---

## 3. Railway par deploy (step by step)

1. **Naya project** → *Deploy from GitHub repo* (ya `railway up` CLI se).
   Repo me `package.json` aur `railway.json` already hain, build khud ho jayega.
2. **PostgreSQL add karein**: project me `+ New` → *Database* → *PostgreSQL*.
3. **App service → Variables** me ye teen add karein:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Reference se chunein) |
   | `SESSION_SECRET` | lamba random string (e.g. 64 random characters) |
   | `APP_TZ` | `Asia/Kolkata` |

4. **Settings → Networking** → *Generate Domain* → URL mil jayega.
5. Deploy hone dein. `railway.json` me start command already
   `npm run migrate && npm start` hai, isliye tables khud ban jayenge
   aur pehla admin bhi ban jayega.
6. Login: `admin` / `admin123` → **turant Security page se password badal dein.**

Health check: `https://<aapka-domain>/health` → `{"ok":true}`.

Agar deploy ke baad "Database tayyar nahi hai" dikhe, to Railway ke
**Console** me ek dafa `npm run migrate` chala dein.

---

## 4. Data import (Add Data)

### A) Excel / CSV upload (recommended)

1. **Add Data** → **Excel template** dabayein → `dp7-upload-template.xlsx` download hoga
2. Us file me apna data daalein (ya apni purani Excel usi format me le aayein)
3. File ko box me drag karein (ya click karke chunein) → **Preview only** → check karein → **Upload & save**

Columns (order koi bhi ho, header padh liya jaata hai):

| Column | Alternate naam jo chal jaate hain |
|---|---|
| `date` | play date, day, din *(optional)* |
| `username` | user, client, name, player, id |
| `mobile` | phone, contact, number, whatsapp |
| `amount` | deposit, amt, value, rs, total |

- **`date` column optional hai.** Na ho to form me chuni hui "Play date" lagegi.
  Ho to **ek hi file me kai dates** aa sakti hain — poora purana history ek baar me import ho jayega.
- Dates `2026-11-20`, `20/11/2026`, `20 Nov 2026` — teeno chalte hain.
- Mobile me `+91`, space, dash — sab saaf ho jaata hai.
- Amount me `₹1,500` ya `1,500` — dono theek.
- **Ek username ek date par sirf ek baar.** Dobara upload karne par woh rows skip ho jaati hain (purana data overwrite nahi hota) — isliye galti se do baar upload karne se kuch kharab nahi hota.
- Har upload ke baad dikhta hai: kitni rows save hui, kaunsi skip hui **aur kyun**, aur kaunse columns pehchane gaye.
- Limit: 20 MB tak ki file.

### B) Seedha paste

Chhoti list ke liye — "Ya seedha paste karein" section:

```
username mobile amount
rahul123  9876543210  500
priya_s   9123456780  1200
amit99    9988776655          ← amount blank = 0
```

- Comma, tab ya space — teeno chalenge.
- `#` se shuru hone wali lines ignore hoti hain.

### Purana data laana (PHP site se)

Agar purane server se CSV/Excel export mil jaye, sabse aasan tareeka:

1. Us file me columns ke naam `date, username, mobile, amount` kar dein
2. Template download karke apna data usme paste kar dein
3. Ek hi baar me upload — 4000+ clients ka history bhi chala jayega

Export ka format alag ho to mujhe bhej dein, main usko convert karke dunga.

---

## 5. Reports ka hisaab (important)

Ye definitions code me fix hain, taaki numbers par sabki samajh ek ho:

- **Level** — client ke lifetime total deposits jo band me fit ho (Settings me editable).
- **Active** — pichhle *active window* (default 7) din me deposit.
- **Regularity (days per week)** — lookback window (default 7 hafte) me deposit ke din ÷ hafte. Yaani 7 hafte me 42 din deposit = 6.0 days/week.
- **Cohort bands** — Settings me set hote hain: Daily ≥6, By Weekly ≥2, Weekly ≥0.75, baaki Monthly.
  *Daily 7 par kabhi kaam nahi karega* — 7 hafte me maximum bhi 7 hi hota hai, isliye default 6 hai.
- **Gone quiet** — apne cohort ka client hai, lekin us period me deposit nahi kiya.
- **Client Reports** — chuni gayi date par jinhone deposit nahi kiya. "Naye quiet" chip = kal tak active the (default), "Poora backlog" = sab inactive.
- **Duplicate** — ek hi mobile number 2+ clients par (data-entry galti pakadne ke liye).

---

## 6. Backup

Hafte me ek baar **Backup & Export → Deposits (CSV)** download karke apne paas
(Drive / pen drive) rakhein. CSV Excel me seedha khulti hai.

---

## 7. Zaroori files

```
src/server.js         app setup, session, routes
src/auth.js           pages, roles, CSRF, audit
src/settings.js       settings + level bands (cached)
src/lib/reports.js    saara report logic (yahan numbers bante hain)
src/lib/dates.js      date/week/month helpers (Asia/Kolkata)
db/schema.sql         poora database structure
scripts/migrate.js    tables + pehla admin
views/                sab pages (EJS)
public/style.css      theme
```





---

## 12. Customer delete (v3.3)

Teen jagah se delete kar sakte hain (sirf Super Admin):

| Kahan | Kya hota hai |
|---|---|
| **Customers** → har row ke aakhir me trash icon | Woh ek customer + uske remarks aur calls |
| **Customers** → checkbox tick → **Delete** button (bulk bar me) | Chune hue saare customers |
| **Customers** → sabse neeche **Customer data delete** card | Sab kuch, scope ke saath |

**Card me do scope hain:**

- **Sirf customer master** — customers, remarks, calls delete. Deposits rows bachi rehti hain,
  isliye **Sync from deposits** dabane par customers wapas ban jayenge.
- **Sab kuch** — customers + deposits + remarks + calls, sab saaf. Phir nayi file upload karein.

Confirm box me `DELETE` likhna zaroori hai — galti se delete na ho.

Delete karne ke baad jinka deposit nahi bacha, unki `last_deposit` / `first_deposit` khud NULL ho jaati hain
(pehle purani dates chipki reh jaati thin — wo bhi v3.3 me theek).

---

## 13. Upload batch protection (v3.4)

Pehle same username + same date + same amount wali rows ko "duplicate" maan ke skip kiya jaata tha.
Isse `25,000` char baar deposit karne wale ka count 1 ho jaata tha aur total bhi kam aata tha.

Ab:

- **Har row ek alag deposit hai** — same amount dobara aaye to bhi count hota hai.
- **Duplicate ka pehchan sirf do cheezon se:**
  1. **transaction id** — wahi ID dobara aayi to line reject.
  2. **file ka hash (batch)** — wahi file dobara upload ho to **poora upload block** ho jata hai,
     count double nahi hota. Pehle "Galat upload hatayein" se hata ke dobara upload karein.
- Upload ke baad **customer-wise hisaab** card dikhta hai — har customer ke kitni rows aur kitna total.
- **Date column na ho to warning** dikhti hai: sab rows form ki date par jayengi.

### Mobile fallback

Excel deposits me mobile khaali hota hai (mobile customers file se aata hai).
Ab `client_stats` customer master se mobile le leta hai — Level Report me number khaali nahi dikhta.


---

## 14. v3.5 — version check + purana index cleanup

Do cheezein jodi gayi:

**1. Version ab screen par dikhta hai**
- Sidebar ke sabse neeche `v3.5.0`
- Login page ke footer me bhi
- `/health` par: `{"ok":true,"version":"3.5.0",...}`

Deploy hua ya nahi, iske bina pata lagana mushkil tha — ab ek nazar me dikh jayega.

**2. Purana daily-unique index zabardasti hata diya**

Kisi bhi database me `(play_date + username)` par bana UNIQUE index — chahe uska naam kuch bhi ho —
ek din me ek hi row aane deta hai. Isse upload me har customer ki sirf **pehli row** bachti thi
(count 1, total kam). Ab `schema-v3.5.sql` startup par aise har index ko dhoondh ke drop karta hai
(naam ka bharosa nahi karta — index definition padhta hai).


---

## 15. v3.6 — Dailyplay7 branding

CRM ab Dailyplay7 logo ke hisaab se black + gold me hai.

| Jagah | Kya |
|---|---|
| Sidebar | Logo ek gold plate/badge me (top par), nav active item gold |
| Login | Logo card ke top par hero banner ki tarah, "RETENTION CRM" gold tagline |
| Buttons | Primary button solid gold, dark text |
| Tables | Header par halka gold tint, hover warm |
| Charts | Gold bars |
| Favicon | Gold "7" mark |

Brand files: `public/brand/wordmark.png` (sidebar), `public/brand/logo-full.png` (login),
`public/brand/mark.png` (icon), `public/favicon.png`.

Naya logo lagana ho to bas `public/brand/wordmark.png` replace kar dein — CSS same rahega.

Icons/status colours (red/green/teal) jaan-boojh ke alag rakhe hain — status padhne me
confusion na ho (VIP badge gold hai, "New" halka teal, danger laal).


---

## 16. v3.7 — gold text wordmark (koi logo image nahi)

Logo image sidebar/login par "ajeeb" lag raha tha — hata diya. Ab **Dailyplay7** sirf
**gold text** hai (serif italic, gradient fill), original script logo ka feel rakhta hai
par crisp rehta hai.

| Jagah | Kya |
|---|---|
| Sidebar | Gold "Dailyplay7" + patli gold underline (koi box/border nahi) |
| Login | Bada gold wordmark + gold rule + "RETENTION CRM" |
| Favicon | Wahi gold "7" mark (browser tab) |

**Browser cache fix:** CSS `?v=<version>` ke saath load hota hai. Pehle theme badalne par
browser purana purple CSS dikha raha tha (1 ghante ka cache) — ab har version bump par
naya CSS khud aa jayega.

**Icon fix:** `trash`, `upload`, `users` teen icons missing the — fallback grid (4 chhote
box) dikh raha tha. Ab proper trash bin, upload arrow aur do log dikhte hain.

**Label fix:** "VIP clan" → "VIP customers".


---

## 17. v3.8 — follow-up scheduling (caller queue)

Pehle remark save hone ke baad koi **agla follow-up date** nahi hoti thi. Caller note me
"after 2days" likhta tha aur yaad rakhna padta tha. List kabhi chhoti nahi hoti thi —
kal wahi 168 naam phir se.

Ab har remark ke saath **follow_up_on** (date) save hoti hai, aur caller ki list sirf
**aaj due** wale dikhati hai.

### Remarks → agla follow-up (default)

| Remark | Agla follow-up |
|---|---|
| No Answer | **kal** |
| Number Not Reachable | kal |
| Will Deposit | **2 din** |
| Interested | 3 din |
| Already Active | 7 din |
| Not Interested | 15 din |
| Wrong Number | 30 din |
| Do Not Contact | **koi nahi** (list se hamesha ke liye hat) |

Caller dialog me **quick buttons** (Kal / 2 din / 3 din / 1 hafta) se badal sakta hai,
ya date picker se koi bhi date de sakta hai.

### My Calls ab kya dikhata hai

- Sirf **aaj due + overdue** customers (jinka follow-up aage hai wo tab tak chhupa)
- **Overdue sabse upar**, laal row me, "X din late" badge ke saath
- 4 counters: **Aaj ka kaam · Overdue · Aaj ho gaya · Aage ke liye rakhe**
- Neeche "Aage ke follow-ups" card — kaun kis din wapas aayega
- "Poori list" toggle — sab kuch dekhne ke liye

### Admin: Follow-ups Due (`/calling/due`)

- Caller-wise: overdue / aaj due / **total pending** / aage rakhe / total assigned / aaj kiya
- **Overdue customers** table — sabse zyada late sabse upar, caller ke naam ke saath
- Aaj kiska kaam hua
- Dashboard par bhi Overdue / Aaj due / Total pending chips

### Do bug fix

- `P3` ka label "callback pending" galat tha — asal me P3 = **reactivated**. Ab sahi.
- "Aaj due" aur "Overdue" dono ek hi number dikha rahe the (overdue due me count ho raha tha).
  Ab alag: **Aaj due** = sirf aaj ki date, **Overdue** = date nikal gayi.

### Purane remarks ka migration

Upgrade par purane remarks ka `follow_up_on` = `action_date + 1` set ho jata hai.
Isliye jin customers ko call ho chuki thi par follow-up nahi hua, wo **overdue** me
dikhne lagenge — yahi sach hai, unhe dobara call karna chahiye.


---

## 18. v3.8.1 — purane follow-up dates ka fix

Do gap mile v3.8 me:

**1. Purane remarks ko galat gap mila**
v3.8 ke migration ne har purane remark ko `action_date + 1` de diya tha — chahe remark
kuch bhi ho. Isliye "Will Deposit" ko bhi 1 din mila jabki uska default 2 din hai.

`schema-v3.8.1.sql` ab unhi rows ko theek karta hai jo migration se bani thin
(`follow_up_on = action_date + 1`) — remark ke hisaab se:

| Remark | Sahi gap |
|---|---|
| Will Deposit / Play Later / Message Done | +2 din |
| Interested / Call Done | +3 din |
| Already Active / Deposited | +7 din |
| Not Interested | +15 din |
| Wrong Number | +30 din |
| Do Not Contact | NULL (koi follow-up nahi) |

Jo caller ne khud date di thi (custom) wo **chhedi nahi jaati**. Dobara chalane par safe.

**2. Follow-ups page ka modal follow-up date set nahi karta tha**
`/followups` page se jo remark add hota tha, usme `follow_up_on` khaali reh jaati thi —
isliye wo customer "due" me gina jaata tha (kabhi schedule hi nahi hua). Ab wo bhi
remark ke default gap se date laga deta hai.


---

## 19. v3.8.2 — caller ko sirf apne customers

Pehle caller ke Customers page par **poore 3,500+** customers dikhte the, aur Calling List bhi
sabki. Ab caller sirf **apne assigned** customers dekhta hai.

| Kya | Super Admin | Caller |
|---|---|---|
| Customers page | Sab customers | **Sirf apne assigned** |
| Total customers counter | Sab | **Sirf apne** |
| Search | Sab | Sirf apne andar |
| Kisi bhi customer ka profile | Haan | **Sirf apna** (doosre par 403) |
| Calling List | Sab + caller filter | **Sirf apne** |
| Assign / DNC / Delete / Sync | Haan | **403** |
| Mobile number | Poora | Masked (••••3210) |

Yaani caller vo hi 5-150 record dekhega jo admin ne usse diye. Poora master kabhi nahi.

### Saath me

- **Khaali nav groups hide** — caller ko RETENTION ke 3 item hi dikhte hain, khaali
  "DATA / REPORTS / ADMIN" labels nahi.
- **P3 ka label sahi** — "callback pending" nahi, **reactivated**.

---

## 20. v3.9 — admin-approved login + 10-hour session + no downloads

Teen cheezein ek saath: **har login par admin ki permission**, **10 ghante ka session**, aur
**non-admin ke liye koi download nahi**.

### Login approval kaise chalta hai

1. User ID + password daalte hi aapke paas request aati hai (`/approvals`)
2. User ek waiting screen dekhta hai — "Admin ki permission ka intezaar hai"
3. Aap **Allow** dabate hain → us page par hi uska login khud khul jata hai (2 second me)
4. **Reject** karein to login nahi hota
5. Request **5 minute** me expire ho jati hai — late approve karne ka faayda nahi

Super Admin ko approval ki zaroorat nahi. Kisi trusted account ko
`Login Approvals → Bina approval login karne wale` se off kar sakte hain.

### Session — 10 ghante, fixed

- Login ke baad **10 ghante** tak chalta hai
- Beech me jitni baar refresh karein, kuch nahi hota (rolling: false — clock aage nahi khisakta)
- 10 ghante poore → **agla refresh par logout**, aur dobara admin ki permission

Badalna ho to env variable: `SESSION_HOURS=10`

### Download band

| Kya | Super Admin | Baaki sab |
|---|---|---|
| Report CSV (`/reports/export`) | Haan | **403** |
| Backup CSV (`/backup/export/*`) | Haan | **403** |
| CSV / Print buttons | Dikhte hain | **Gayab** |
| Mobile number | Poora | **Masked** (••••3210) |
| Login Approvals page | Haan | **403** |

### Security audit (v3.9)

Poore code ke 62 routes check kiye:

- **9 routes** bina guard — sab `auth.js` ke login routes (public hona chahiye) ✅
- **53 routes** par `requireLogin` / `requirePage` / `requireSuperAdmin` ✅
- 4 router-level guards: approvals, backup, settings, users (sab `requireSuperAdmin`)
- CSRF har non-GET request par (multipart routes me andar verify)
- Login: 5 galat password → 15 minute lock
- Session cookie: httpOnly, sameSite=lax, secure auto
- Login par session regenerate (fixation se bachav)

---

## 21. v4.0 — New Clients window

Ek naya page: **New Clients** — mahine ke har din kitne naye clients aaye, 1 se 31 tak.

### Kaise dekhta hai

- **Calendar grid** (Mon–Sun) — har din ke box me us din ke naye clients ka number
- **6 counters**: is mahine total (pichhle mahine se compare), **aaj**, **kal**, roz ka average,
  sabse achha din, aur zero din (jin din koi naya client nahi)
- **Kisi din par click** → us din ke saare naye clients ki table (username, mobile,
  deposits, total, level, status, caller, last remark)
- Left/right arrows se koi bhi mahina — "Pichhla mahina" chip bhi hai
- **CSV** (sirf Super Admin)

### Mahina auto-reset

Window hamesha **current month** par khulti hai. 1 tareekh aate hi naya mahina shuru —
pichhla mahina apne aap window se hat jata hai. Data delete nahi hota, arrows se
pichhla mahina dekh sakte hain.

### "Naya client" ka matlab

Jiska **pehla deposit** us din hua. Ek hi client dobara deposit kare to wo naya nahi ginta —
sirf pehla din ginta hai.

### ⚠️ Date ka dhyan

File me date column na ho to **Daily Upload ke "Date" box** wali date lagti hai.

> 1 tareekh ka data 2 tareekh ko upload kar rahe hain → Date me **1 tareekh** chuniye.
> Warna wo client is window me 2 tareekh par ginega.

Ye warning ab Daily Upload page par bhi dikhti hai.

### Access

- Page access key: `newclients` (Users page se grant karein)
- Mobile number non-admin ko masked
- CSV aur export sirf Super Admin

---

## 22. v4.1 — daily target + progress

Har caller ka **roz ka target** (default 40), aur My Calls par uski progress.

### Aapke liye (admin)

- **Users** page me naya **Target** column — har user ka target dikhta hai
- Naya user banate waqt **"Roz ka call target"** box (default 40)
- Edit dialog me bhi badal sakte hain — **0 = koi limit nahi** (poori list dikhegi)
- **Follow-ups Due** page par har caller ke saamne **progress bar**: `14/40 · 26 baaki`
- Total row me sab callers ka `14 / 40`

### Caller ke liye (My Calls)

- Sabse upar **"Aaj ka target"** card — bada number `14 / 40`, progress bar
- **List sirf baaki target jitni** dikhti hai (14/40 ho to 26 rows)
- Neeche ek line: *"20 customers aur due hain, par ye aaj ke target se bahar hain — kal ki list me sabse upar aayenge"*
- Target poora hote hi ✅ **"Aaj ka target poora"** card + **"Phir bhi poori list dekhein"** button

### "Aaj ka kaam" kaise gina jaata hai

Aaj jitne **alag customers** ko touch kiya — remark **ya** call. Ek hi customer ko do baar
remark karne se ginti nahi badhti (haan, par asli kaam ek hi hai).

### 🔴 Ek bada bug bhi theek hua — timezone

Database server **UTC** par chalta hai (Railway bhi), par app ka business din
**Asia/Kolkata** ka hai. Isse SQL ka `CURRENT_DATE` ek din peeche reh jata tha —
matlab shaam 6:30 baje ke baad app "kal" ki date dikhata tha, aur
**"aaj ka kaam", "due", "overdue" sab galat** aata tha (screenshot me 14 kaam ho gaye
the par progress 0/40 dikha raha tha).

Ab har DB connection par `SET TIME ZONE 'Asia/Kolkata'` chalta hai — dono ek hi din par.
Ye **follow-up dates, overdue count aur new clients window** sab ko theek karta hai.

---

## 23. v4.2 — barabar auto-split + Caller Load

Pehle customers baantna check-box ka kaam tha: "Poora filter assign karein" poora batch **ek**
caller ko de deta tha. 2,786 customers ko 8 callers me 600-600 baantne ke liye 600 tick × 6 baar
karna padta — practical nahi tha.

### Naya page: Caller Load (`/callers`, sirf Super Admin)

Har caller ka ek line me pura hisaab:

| Column | Matlab |
|---|---|
| **Team** | Retention / Acquisition — dropdown se badal sakte hain |
| **Target** | Roz ka call target |
| **Load** | `assigned / (target × 4 din)` — bar + health badge |
| **P1 / P2** | Uske paas kitne VIP-inactive aur normal inactive |
| **Pending / Overdue** | Follow-up ka bojh |
| **Aaj kiya** | Aaj kitne customers touch kiye |
| **Last login** | Kabhi login nahi kiya to "kabhi nahi" |

**Health** = assigned ÷ (target × 4 din):
`khaali` (0) · `halka` (<50%) · `theek` (50–105%) · `bhaari` (105–130%) · `zyada` (>130%)

### Even auto-split

Form: kaun se customers (bina caller / sab), priority filter, har caller ko kitne (khaali =
barabar), total kitne baantne hain, aur kis-kis caller me.

**Pehle Preview** — kuch save nahi hota. Preview me dikhta hai har caller ko kitne milenge aur
P1/P2/P3/P4 ka kya mix. **Assign karein** dabane par hi badalta hai.

**Algorithm** — priority bucket ke hisaab se round-robin:

```
P1 → samira, soheb, soni, Diksha, arun, kamal (round-robin)
P2 → soheb, soni, Diksha, arun, kamal, samira (agle se shuru)
P3 → ...
P4 → ...
```

Har bucket alag round-robin hoti hai, isliye har caller ko **har priority se barabar hissa**
milta hai — VIP sab ek caller ke paas nahi jaate. Agar simple "pehle 600 isko" karte to ek ke
paas saare P1 chale jaate.

- **P0 (Do Not Contact)** kabhi assign nahi hota
- **per_caller** diya ho to cap lagta hai (baaki queue me rehte hain)
- **take** diya ho to sirf utne hi baante jaate hain
- Har split `split_runs` me record hota hai (kisne, kab, kitne)

### Saath me

- **`users.team`** — retention (purane client ka follow-up) / acquisition (naye client laana)
- **`customers.acquired_by`, `acquired_on`** — kis caller ne customer laaya (acquisition ke liye)
- **Users page** me Team column + create/edit me Team dropdown, default target 150
- **`/calls` scope fix** — caller ab sirf apni calls dekhta hai (pehle sab callers ki dikhti thin)
- **`/new-clients` scope fix** — caller ab sirf apne assigned clients dekhta hai
- **`/callers`** non-admin ke liye 403

### 🔴 Ek production bug bhi theek hua

`schema-v3.sql` `CREATE OR REPLACE VIEW customer_board` karta tha. v4.2 ne us view me naye
columns add kiye (acquired_by, caller_team). Agli baar server start hote hi purana schema
wahi view purane columns ke saath replace karne lagta → **"cannot drop columns from view"** →
bootstrap beech me ruk jata, aur uske baad ke saare schema (index cleanup sameth) lagne hi
band ho jaate.

Ab `DROP VIEW IF EXISTS customer_board` karke naya banate hain — teen baar lagatar bootstrap
chalake verify kiya, har baar saaf.

---

## 24. v4.3 — Retention Cadence Engine

Pehle follow-up date **sirf remark se** banti thi. Jis customer ko koi call hi na
kare, uski koi date hi nahi — aur jo deposit kar deta wo queue se hamesha ke liye
gayab. "Regular retention" ka matlab har customer ka apna **cycle** hona chahiye,
ek baar call karke chhod dena nahi.

### Tier aur cycle

| Tier | Kaun | Cycle |
|---|---|---|
| **A** | VIP, 25+ deposit, ya recently inactive (≤14 din) | **5 din** |
| **B** | normal aur active customer | **12 din** |
| **C** | 60 din se purana dormant | **30 din** |
| **D** | Wrong Number / Do Not Contact | koi touch nahi |

### next_touch_on — asli engine

Har customer ka ek agla scheduled touch hota hai:

```
remark hai aur usme follow_up_on hai  → wahi date (caller ka faisla)
remark hai par follow_up_on khaali    → action_date + tier gap
remark hi nahi (kabhi call nahi hua)  → last_deposit + tier gap
```

Isse **jo kabhi call nahi hua wo bhi due** hota hai — pool me koi nahi padta.
Remark save hote hi cycle reset — dobara call nahi karna padega kisi ko.

### My Calls ab kaise chalti hai

- **Ordering**: overdue → **tier A** → tier B → tier C → phir deposits
  (target 150 kam pad jaye to VIP kabhi squeeze out nahi hote)
- **Naya "Aaj due — tier" card**: `A 53 · B 0 · C 27`
- Har row par **Tier** badge aur **Cadence** column — `35 din late · 22 Oct 2026`

### Admin: Cadence page (`/cadence`, sirf Super Admin)

| Counter | Matlab |
|---|---|
| Cadence me | kitne customers cycle me hain (DNC chhod ke) |
| 7 din me touch hue | coverage — asli health metric |
| **Bhoole gaye** | 7 din se koi touch nahi — **yahi red flag hai** |
| Kabhi call nahi | ek baar bhi nahi |
| Abhi due | cadence date nikal gayi |
| **Ek round** | poore base ka ek chakkar kitne din me + roz kitni calls chahiye |

Saath me tier-wise table, caller-wise coverage bar, **roz ka bar chart**, aur
"sabse zyada chhoote gaye" (2+ deposit wale, top 25) ki list.

Agar ek round ka time chuna hua window se zyada ho, page khud laal warning deta hai —
kitni calls/din chahiye aur capacity kitni hai.

### Recompute kab chalta hai

- Server start par
- Har deposit sync ke baad (status/VIP badla → tier badla)
- Har remark save par (sirf us ek customer ka)
- `/cadence` par **Recompute** button se poora base

---

## 25. v4.3.1 — bulk assign ka data bug (important)

### Kya galat tha

Customers page ka bulk bar filter ke hisaab se assign karta tha, par **filter
form se bulk bar tak pahunchta hi nahi tha**. Route `f_status` / `f_vip` /
`f_priority` padhta tha, aur view unhe bhejta hi nahi tha.

Isliye:

```sql
-- jabh bhi "Poora filter assign karein" dabaya
UPDATE customers SET assigned_to = X
 WHERE id IN (SELECT id FROM customer_board WHERE TRUE)   -- ← SAARE customers
```

Matlab page par 267 dikh rahe the, par command **4,825** par chalti thi.
Aur agar caller dropdown khali tha, to **saare customers se caller hat jata tha**.

### Ab kya hai

1. **Filter sach me jaata hai** — `f_status`, `f_vip`, `f_priority`, `f_caller`,
   `f_q` sab hidden inputs se (jo page par laga filter hai, wahi bulk par lagta hai)
2. **Filter khali ho to block** — "Filter khali hai — ye SAARE 4,825 customers par lagega"
3. **Caller chune bina assign nahi hota** — saaf error
4. **Alag "Bina caller karein" button** — pehle dropdown me "— caller hatao —"
   chunna padta tha, jo galti se assign kar deta tha. Ab unassign apna alag button hai
5. **Confirm me asli number** — "Is filter ke 267 customers ko … de dein?"
6. **Filter badge** — bar par dikhta hai `filter laga hua` ya
   `koi filter nahi — sab par lagega`
7. **Unassign data nahi todta** — remarks, follow-ups, deposits, call history sab safe
