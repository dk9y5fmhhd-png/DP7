# DP7 — naya system (Node.js + PostgreSQL)

Client deposits, retention reports aur follow-ups ka poora admin system — purane PHP version ki jagah, scratch se likha hua.

> **Ek line me:** `npm run migrate` → `npm start` → login → data daalna shuru.

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




