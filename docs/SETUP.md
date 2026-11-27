# Setup and testing: languages, TeleCMI, WhatsApp

## Languages (English and Hindi)

- Each person switches with the buttons on the sign-in page or top bar; the choice is saved on the account.
- **Settings → General → Default language** applies until someone chooses.
- Text lives in the screens as `_t('English sentence')`; Hindi is in `src/locales/hi.json`. When adding text, add its Hindi there. `npm run test:i18n` (empty test database, like below) fails if one is missing.
- Not translated: customer names, notes, level names, template messages, uploaded data, Excel column names, downloaded files and the audit log.
- **A Hindi speaker should review the wording.**

## Run locally

Two processes, in two terminals, from the DP7 folder. `.env` needs `CREDENTIALS_ENCRYPTION_KEY` and `WA_INTERNAL_TOKEN` (see `.env.example`).

```bash
npm start
```

```bash
npm run start:wa
```

Tests (use an **empty** test database; `SEED_ADMIN_PASSWORD` must be `admin123` while creating it and testing):

```bash
DATABASE_URL=postgresql://localhost/dp7_test SEED_ADMIN_PASSWORD=admin123 npm run migrate
```

```bash
DATABASE_URL=postgresql://localhost/dp7_test npm run test:integrations
```

The tests use a mock TeleCMI server and a stand-in WhatsApp library.

## TeleCMI test with real credentials

1. **Settings → Calling → Add account:** name, app ID, app secret. Press **Test**.
2. On the same page, **Setup in the TeleCMI panel** shows what to enter in TeleCMI (Developer):
   - Webhooks: one of type **CDR** and one of type **Notify**, method **POST**, both the Server URL shown. It is one address for all accounts and contains a secret code. Call results arrive only at a public HTTPS address.
   - **IP whitelisting:** the server's outgoing IP, from `SERVER_PUBLIC_IP`. On Railway this needs **Static Outbound IPs** (listed for the Pro plan); add every address shown and redeploy.
3. **Users** page: use the phone button (or Edit) to paste each caller's agent ID (`5001_<app id>`) and optional password. The matching account and shared IDs are shown. Press **Test login**.
4. Assign a test customer (with your own mobile number) to a caller.
5. Sign in as that caller, with the TeleCMI app open, press **Call** and confirm.
6. Check **Call Log** for status and duration after the webhook arrives.

Changing `CREDENTIALS_ENCRYPTION_KEY` also changes the webhook address.

**Still unconfirmed:** which field in the real webhook matches the click-to-call request. The code tries the call IDs, then agent + number within two hours. After the first real call, check this:

```sql
SELECT payload FROM telecmi_webhook_logs ORDER BY id DESC LIMIT 5;
```

## WhatsApp test

Use a spare number. WhatsApp can restrict or ban numbers connected this way.

WhatsApp is not in the side menu. Super Admins open it from **Settings → WhatsApp**; callers open the inbox from **My Calls** and send from the button on a customer.

1. **WhatsApp → Numbers:** add a number, press **Link with QR**, scan it from the phone (Linked devices).
2. Tick who may send from it and set the daily limit. Start low.
3. **Templates:** add a message such as `Hello {1}, we missed you.`
4. Users page: give callers the **WhatsApp** page.
5. As a caller, open a customer's WhatsApp button, send, reply from the phone, check the **Inbox**.
6. Reply `STOP` and confirm further sends are refused.

## Railway

**Important:** Railway's documentation says config files such as `railway.json` stop being read on **1 December 2026**. Set these in each service's settings and check the current service before that date.

| Setting | Web service | WhatsApp service (new, same repo) |
|---|---|---|
| Start command | `npm start` | `npm run start:wa` |
| Pre-deploy command | `npm run migrate` | none |
| Health check path | `/health` | `/health` |
| Public domain | yes | **no** |
| Replicas | 1 | **1** |

Variables on **both**: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `APP_TZ=Asia/Kolkata`, `NODE_ENV=production`, and the same `CREDENTIALS_ENCRYPTION_KEY` and `WA_INTERNAL_TOKEN`.

Web only: `SESSION_SECRET`, `APP_PUBLIC_URL=https://<your domain>`, `WA_SERVICE_URL=http://<wa service name>.railway.internal:3100`.

Web only (TeleCMI): `SERVER_PUBLIC_IP=<outgoing addresses, comma separated>`.

WhatsApp only: `PORT=3100`, `WA_PORT=3100`, `WA_BIND_HOST=::`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=10`.

Order: take a database backup, set the variables, deploy the web service (creates the new tables), then the WhatsApp service. Try it in a staging environment first.

Generate each key with:

```bash
openssl rand -hex 32
```

Never change `CREDENTIALS_ENCRYPTION_KEY` after secrets are saved.

## Changed behaviour

- The old single TeleCMI screen is gone; re-enter the account under **Settings → Calling**.
- The Call button no longer logs a "manual" call or shows a number when TeleCMI is not set up.
- Callers can call, message and add remarks only on customers assigned to them.
- Old TeleCMI values stay in the database as plain text. After the new setup works, remove them:

```sql
DELETE FROM settings WHERE key LIKE 'telecmi_%';
```
