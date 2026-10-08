# LogisticBay Timesheets — Deployment runbook

> How this product is deployed, and nothing about whether it is: STATUS.md
> owns what is built and live. The decisions behind this file are D3 (domains),
> D14 (Railway + Vercel), D45 (browser credentials), D55/D56 (email) and D57
> (the first deployment).
>
> **Every step that creates or changes a cloud resource, a secret or a DNS
> record needs the owner's approval at the time it is done.**

## 0. Independence from the LogisticBay TMS

LogisticBay Timesheets and LogisticBay TMS share the brand and the
`logisticbay.com` DNS zone — nothing else.

| | Timesheets | TMS (never touched from here) |
|---|---|---|
| Repo | `Q25ltd/LB-Timesheet` | `Q25ltd/LB-TMS` |
| Railway project | **`LB-Timesheet`** (new) | `LB-TMS` |
| Vercel project | **new**, e.g. `lb-timesheets-web` | `logisticbay` |
| Web | `timesheets.logisticbay.com` | `www.logisticbay.com` (apex redirects) |
| API | `api.timesheets.logisticbay.com` | `api-production-cdc9.up.railway.app` |
| Database | its own Railway Postgres | its own |
| Email | Amazon SES (us-east-1) | SendGrid — its DNS records stay |

Never: a shared database, credentials, JWT secret, cookie domain, Railway or
Vercel project, or environment variable. Never point a Timesheets
`DATABASE_URL`, migration or script at the TMS database.

## 1. Railway — PostgreSQL

1. Railway project **`LB-Timesheet`** → add **PostgreSQL**. No public
   networking for it: the API reaches it over Railway's private network.
2. Backups (section 6) — enable before the first real data.
3. The migrations create the `citext` extension (`CREATE EXTENSION`); Railway
   Postgres allows it.

## 2. Railway — the API service

Service from `Q25ltd/LB-Timesheet`, **root directory `api/`**, builder
Railpack. Settings in the Railway dashboard (Railway's `railway.json`
config-as-code is deprecated, so none is committed):

| Setting | Value | Why |
|---|---|---|
| Node | from `api/package.json` `engines`: `22.x` | check-rules needs ≥ 22.13 |
| Build command | `npm run build` | `prisma generate` + `tsc -p tsconfig.build.json` → `dist/` |
| Pre-deploy command | `npm run migrate:deploy` | `prisma migrate deploy` — never `db push`, never `migrate dev`, never `migrate reset` |
| Start command | `npm start` | `node dist/server.js` — no `tsx` (F-17) |
| Healthcheck path | `/health` | readiness: 200 only when the database answers |
| Healthcheck timeout | 120 s | |
| Restart policy | On failure | a database outage is a 503, not a crash — nothing restarts |
| Wait for CI | **on** | a commit deploys only after the `ci` and `e2e` checks pass |
| Watch paths | `api/**` | web or mobile commits do not redeploy the API |
| Custom domain | `api.timesheets.logisticbay.com` | |

### Environment variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Postgres service's **private** URL — `${{Postgres.DATABASE_URL}}` |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | NEW: `openssl rand -hex 32` (64+ characters). **Never the TMS's.** |
| `WEB_ORIGIN` | `https://timesheets.logisticbay.com` |
| `WEB_APP_URL` | `https://timesheets.logisticbay.com` |
| `CLIENT_IP_SOURCE` | `x-real-ip` (section 5) |
| `MAIL_TRANSPORT` | `disabled` for the first deploy; `ses` only when email goes live |
| `AWS_REGION` | `us-east-1` (with `ses`) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | IAM user `lb-timesheets-ses` — only with `ses`; created by the owner, pasted straight into Railway |
| `SES_NOTIFICATION_TOPIC_ARN` | only after section 7 |
| `PORT` | set by Railway — not set by hand |

The API refuses to start if any of these is missing or malformed in
production (`api/src/lib/env.schema.ts`) — including an unset
`MAIL_TRANSPORT` or `CLIENT_IP_SOURCE`.

### Health

| Path | Meaning | Answers |
|---|---|---|
| `/health/live` | the process is up | always 200 while it runs — never touches the database |
| `/health` | the API can serve | 200 with the database up; **503** when it is down |

A database outage is visible (503) without restarting a healthy process; it
recovers by itself when the database returns. Point an uptime monitor at
`/health`.

### Migrations against running versions

Railway runs the pre-deploy migration while the PREVIOUS version still
serves traffic. So every migration must work with the version before it:

- **Additive only** in a normal deploy: new tables, new nullable columns, new
  indexes, new enum values.
- A destructive change (drop, rename, retype, `SET NOT NULL`, delete or
  truncate data) is two deploys — stop using it, then remove it — and needs
  the owner's approval, written in the migration file:
  `-- migration-destructive-approved: <why, and the two-step plan>`.
  `npm run check:rules` fails any later migration that does not
  (`migration-additive`). The 17 migrations up to
  `20261008120000_email_delivery_status` are the pre-production baseline,
  applied to an empty database on the first deploy.
- A failed migration fails the deploy; the previous version keeps serving.
- Take a manual backup before any migration that rewrites existing rows.

## 3. Vercel — the company portal

New Vercel project (never the TMS's `logisticbay`), from `Q25ltd/LB-Timesheet`,
**root directory `web/`**. `web/vercel.json` carries the rest:

- framework Vite, `npm ci`, `npm run build`, output `dist`
- every path rewrites to `index.html` — direct visits, refreshes and the
  emailed `/verify-email` and `/reset-password` links work
- security headers: a Content-Security-Policy allowing scripts and styles from
  the site only and connections only to `https://api.timesheets.logisticbay.com`,
  HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`
- `/assets/*` (content-hashed) cached for a year; nothing else

Production branch `main`. `VITE_API_URL` is not needed: a production build
uses `https://api.timesheets.logisticbay.com` (`web/src/auth/apiBase.ts`). If
it is ever set to another API, the CSP's `connect-src` in `web/vercel.json`
must change with it — the test in `web/src/deployment.test.ts` keeps the
default and the CSP in step. Preview deployments are refused by the API's
CORS (exact origins only) — expected.

## 4. DNS — Wix

Two new records, values given by Vercel and Railway when the domains are
added; nothing existing is touched (the SendGrid, Google Workspace and SES
records all stay):

| Host | Type | Value |
|---|---|---|
| `timesheets` | CNAME | Vercel's target |
| `api.timesheets` | CNAME | Railway's target (plus any verification TXT Railway asks for) |

Certificates are issued automatically.

## 5. Verifying the client address (F-15) — first private deploy

The API keys every rate limit on the client address from `X-Real-IP`, which
Railway's edge sets on every public request, overwriting any copy the caller
sends (Railway's guidance; its handling of `X-Forwarded-For` is not reliably
documented, so that header is never read and Fastify's `trustProxy` is off).
Verify it on the live edge before opening the API to the public:

```bash
curl -s -D - -o /dev/null https://api.timesheets.logisticbay.com/health/live | grep -i x-ratelimit-remaining
curl -s -D - -o /dev/null https://api.timesheets.logisticbay.com/health/live | grep -i x-ratelimit-remaining
curl -s -D - -o /dev/null -H "X-Real-IP: 203.0.113.99" https://api.timesheets.logisticbay.com/health/live | grep -i x-ratelimit-remaining
```

1. The count falls by one per request (e.g. 299, 298) — the bucket is yours.
2. **The forged `X-Real-IP` request continues the SAME count** (297) — the
   edge replaced the header. If it starts again at 299, the edge passed the
   forged value through: set `CLIENT_IP_SOURCE=socket` and stop.
3. From a second network (a phone hotspot) the count starts at 299 — clients
   are separated, not sharing the proxy's bucket. If it continues the first
   network's count, `X-Real-IP` is not reaching the API: investigate before
   going public.

## 6. Backups — Railway Postgres

| Option | Retention | Protects against | Notes |
|---|---|---|---|
| Volume backups — daily | **6 days** | bad data, mistakes | Backups tab; incremental, billed as volume storage |
| Volume backups — weekly | 27 days | slower-noticed mistakes | combinable with daily |
| Volume backups — monthly | 89 days | | |
| Point-in-time recovery (PITR) | ~4 weeks, to any moment | bad data at a known time | WAL archived to a Railway bucket; restores into a NEW service; no separate fee (bucket storage + egress); window starts at enabling |
| Logical dump (`pg_dump`) to storage outside Railway | your choice | **deleting the volume or project** — which wipes every Railway backup | a scheduled job; must be restore-tested |

Daily volume backups alone keep 6 days — short of a 7-day minimum.
**Recommended minimum:**

1. **Enable PITR** before real data — continuous, ~4-week window.
2. Volume backups **daily + weekly** — 6 days of daily points, 27 days weekly.
3. Before going public: a **daily `pg_dump` to storage outside the Railway
   project** (e.g. an S3 bucket in the LogisticBay AWS account, encrypted,
   lifecycle-expired after 14 days) — the only copy that survives losing the
   project.
4. **A restore drill** before real customers: restore into a new service,
   point a scratch API at it, sign in.

## 7. Email — Amazon SES

The first deployment runs with `MAIL_TRANSPORT=disabled`: the API starts
without AWS credentials, every send fails and is logged, and the startup log
says email is disabled. Registration cannot be completed then — expected for
an infrastructure test.

To go live (owner approval each time): create the access key for
`lb-timesheets-ses` → set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION=us-east-1`, then `MAIL_TRANSPORT=ses` → redeploy → one test email.
Bounces and complaints: an SNS topic in us-east-1 → SES identity
notifications (Bounce, Complaint) for `logisticbay.com` → subscribe
`https://api.timesheets.logisticbay.com/webhooks/ses` (the API confirms it) →
set `SES_NOTIFICATION_TOPIC_ARN`.

## 8. The mobile app

Not released by this deployment. A development build reaches the deployed API
with `EXPO_PUBLIC_API_URL=https://api.timesheets.logisticbay.com`
(`mobile/src/api/config.ts`). Native apps send no `Origin`, so CORS does not
apply to them.

## 9. Rollback

- API: Railway → Deployments → redeploy the previous deployment. Possible
  because every migration is additive (section 2).
- Web: Vercel → promote the previous deployment.
- Data: PITR to a new service, then repoint `DATABASE_URL`.
