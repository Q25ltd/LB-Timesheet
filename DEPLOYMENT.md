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
| Vercel project | **`lb-timesheets-web`** | `logisticbay` |
| Railway region | **EU West (Amsterdam)** — `europe-west4-drams3a` | its own |
| Web | `timesheets.logisticbay.com` | `tms.logisticbay.com` (and `www`, until the brand site takes it) |
| API | `api.timesheets.logisticbay.com` | `api-production-cdc9.up.railway.app` |
| Database | its own Railway Postgres | its own |
| Email | Amazon SES (us-east-1) | SendGrid — its DNS records stay |

Never: a shared database, credentials, JWT secret, cookie domain, Railway or
Vercel project, or environment variable. Never point a Timesheets
`DATABASE_URL`, migration or script at the TMS database.

## 1. Railway — PostgreSQL

1. Railway project **`LB-Timesheet`** (workspace plan: Hobby) → add
   **PostgreSQL** (the template's image is pinned to major 18 — CI tests the
   same major). No public networking for it: the template adds no TCP proxy
   and no `DATABASE_PUBLIC_URL`, and none may be added — the API reaches it at
   `postgres.railway.internal`.
2. **Region: EU West (Amsterdam)** for both services. A region change on a
   service with a volume migrates the volume (Railway backs it up in the old
   region, copies it, checks it, then mounts it); the database is not
   recreated and its credentials, being variables, do not change. Expect
   downtime while it copies. Move Postgres first, then the API, so they share
   a region.
3. Backups (section 6) — in place before the first real data.
4. The migrations create the `citext` extension (`CREATE EXTENSION`); Railway
   Postgres allows it.

## 2. Railway — the API service

Service **`timesheets-api`** from `Q25ltd/LB-Timesheet`, **root directory
`api/`**, builder Railpack. No `railway.json` is committed. The settings live
in the Railway environment config — set in the dashboard, or with
`railway environment edit` and a JSON patch on stdin (the `--service-config`
form silently applies nothing); "Wait for CI" is `source.checkSuites: true`:

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
| Custom domain | `api.timesheets.logisticbay.com`, target port 8080 | plus a generated `timesheets-api-production.up.railway.app` for checks |

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
| `SES_CONFIGURATION_SET` | `lb-timesheets` — required with `ses` (D58) |
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

Vercel project **`lb-timesheets-web`** (never the TMS's `logisticbay`), from
`Q25ltd/LB-Timesheet`, production branch `main`, **root directory `web/`**,
framework Vite, Node 22.x. Vercel's default deployment protection stays on:
preview and branch URLs need a Vercel login; the production alias
(`lb-timesheets-web.vercel.app`) and the custom domain do not. Because the
build calls the production API host, a page on the `.vercel.app` alias cannot
reach the API (CORS admits only the custom domain) — check the portal on
`timesheets.logisticbay.com`. `web/vercel.json` carries the rest:

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

Three new records, values read from Vercel and Railway when the domains were
added — never guessed; nothing existing is touched (the SendGrid, Google
Workspace, SES and TMS records all stay):

| Host | Type | Value |
|---|---|---|
| `timesheets` | CNAME | `c6ab45be568d0a27.vercel-dns-017.com` (Vercel's first-ranked target for this project) |
| `api.timesheets` | CNAME | `p0t5uy66.up.railway.app` |
| `_railway-verify.api.timesheets` | TXT | Railway's ownership token (`railway-verify=…`) — required before Railway issues the certificate |

Certificates are issued automatically (Let's Encrypt); Railway's took about
nine minutes after the records resolved. A resolver that looked a name up
before its record existed caches the miss for up to an hour (the zone's SOA
negative TTL): check from `1.1.1.1` or mobile data, not from a Mac that
asked early.

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

**On the Hobby plan Railway creates no backups at all.** The Postgres
Backups tab says creating backups and enabling point-in-time recovery are
Pro-only; Hobby can only restore backups that already exist. The table below
is what Pro offers. On Hobby, the minimum is the independent daily
`pg_dump` in point 3 of the recommendation — before any real data.

| Option | Retention | Protects against | Notes |
|---|---|---|---|
| Volume backups — daily | **6 days** | bad data, mistakes | Backups tab; incremental, billed as volume storage |
| Volume backups — weekly | 27 days | slower-noticed mistakes | combinable with daily |
| Volume backups — monthly | 89 days | | |
| Point-in-time recovery (PITR) | ~4 weeks, to any moment | bad data at a known time | WAL archived to a Railway bucket; restores into a NEW service; no separate fee (bucket storage + egress); window starts at enabling |
| Logical dump (`pg_dump`) to storage outside Railway | your choice | **deleting the volume or project** — which wipes every Railway backup | a scheduled job; must be restore-tested |

> **Postponed (D59, 2026-10-09).** No backups run today. Before the first
> paying customer: Railway Pro, then its point-in-time recovery plus daily and
> weekly volume backups (the table above). Sections 6.1–6.7 describe the
> custom job that was built instead and is idle; its credentials are not to
> be created unless the owner revives it.

Daily volume backups alone keep 6 days — short of a 7-day minimum — and
none of the Railway options exists on Hobby. **What was built instead (D59, now idle): a
nightly encrypted `pg_dump` to S3, outside Railway** — a copy that would also
survives losing the volume or the project.

### 6.1 The nightly backup job

```
Railway Postgres ──private network──▶ timesheets-backup (cron, 03:00 UTC)
   pg_dump -Fc as lb_backup (read-only role), 30-minute limit
   → pg_restore --list: must read back, must hold _prisma_migrations
   → age-encrypted to the owner's PUBLIC key; plaintext deleted
   → S3 PutObject, SHA-256 checksum S3 verifies, If-None-Match: *,
     key pg/YYYY/MM/DD/lb-timesheets-<UTC time>-<random>.dump.age
   → S3's acknowledged checksum must equal ours
   → only then the success ping; anything else pings /fail and exits 1
```

Code: `ops/backup/` — `backup.sh` (the job), `Dockerfile` (PostgreSQL 18
client, age, AWS CLI; runs as a non-root user; no application code),
`backup-role.sql`, `restore-check.sh`. Tests: `npm run test:backup`, part of
`npm run check`. Overlap: Railway skips a cron run while the previous one is
still running, and the job itself stops after 30 minutes.

### 6.2 The bucket — `lb-timesheets-backups`, eu-west-2

| Setting | Value | Why |
|---|---|---|
| Block Public Access | all four on | |
| Object Ownership | bucket owner enforced (no ACLs) | |
| Default encryption | SSE-S3 | the content is already age-encrypted; this is the second layer |
| Versioning | on | Object Lock requires it |
| Object Lock | **Governance, 14 days default retention** | no version can be deleted or overwritten for 14 days — not by the backup key, not by a stolen admin login without the explicit bypass header |
| Lifecycle | current versions expire at **15 days** (a delete marker); noncurrent versions are deleted **1 day** after; expired delete markers removed; incomplete uploads aborted after 1 day | AWS: "a locked version of an object cannot be deleted by a S3 Lifecycle expiration policy" — expiry adds a delete marker, and the version itself goes only once its lock has lapsed. Effective retention: 14 days guaranteed, about 16 kept |
| Bucket policy | deny any request not over TLS; deny `s3:BypassGovernanceRetention` to every principal but the account root | only the root user can shorten a lock |

Compliance mode was not chosen: it cannot be shortened by anyone, including
for an erasure request (O1 retention is still open).

### 6.3 The backup identity — IAM user `lb-timesheets-backup`

One inline policy: `s3:PutObject` on `arn:aws:s3:::lb-timesheets-backups/pg/*`
— nothing else. It cannot read, list, delete, change retention, or touch SES
or any other bucket; a stolen key can add files and nothing more. Its access
key is created by the owner and pasted only into the backup service.

### 6.4 The database role — `lb_backup`

`ops/backup/backup-role.sql`, run once as the database owner: `LOGIN`, no
superuser, no role or database creation, at most 2 connections, member of
PostgreSQL's built-in read-only `pg_read_all_data`, sessions read-only by
default. Rehearsed against PostgreSQL 18: even after switching read-only off
and opening a read-write transaction it is refused every INSERT, UPDATE,
DELETE, CREATE TABLE, DROP TABLE and CREATE ROLE. The backup service has
THIS role's password — never the application's `DATABASE_URL`.

### 6.5 The service — Railway `timesheets-backup`

In project `LB-Timesheet`, EU West. Source `Q25ltd/LB-Timesheet`, root
`/ops/backup`, Dockerfile builder, watch path `/ops/backup/**`, cron
`0 3 * * *` (UTC), restart policy **never**, no public domain, Wait for CI.

| Variable | Value |
|---|---|
| `PGHOST` | `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}` (`postgres.railway.internal`) |
| `PGPORT` | `5432` |
| `PGDATABASE` | `${{Postgres.PGDATABASE}}` |
| `PGUSER` | `lb_backup` |
| `PGPASSWORD` | the `lb_backup` password — generated at role creation, set once, never shown |
| `AGE_RECIPIENT` | the owner's age PUBLIC key (`age1…`) |
| `S3_BUCKET` | `lb-timesheets-backups` |
| `AWS_REGION` | `eu-west-2` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `lb-timesheets-backup`'s key — the owner creates and pastes it |
| `HEALTHCHECK_URL` | the healthchecks.io ping URL (check: period 1 day, grace 2 hours) |

### 6.6 What only the owner does

1. **The age key pair**, on the owner's own machine (`brew install age`):
   `age-keygen -o lb-timesheets-backup.agekey`. It prints the PUBLIC key
   (`age1…`) — that goes into `AGE_RECIPIENT`. The FILE is the private key:
   keep it in a password manager and one offline copy, never in Git,
   Railway, chat or email. Without it no backup can ever be read.
2. **The backup access key**: IAM → Users → `lb-timesheets-backup` →
   Security credentials → Create access key ("Application running outside
   AWS"), pasted straight into the two Railway variables.
3. **healthchecks.io**: a check named `lb-timesheets-backup`, period 1 day,
   grace 2 hours, email notification; its ping URL into `HEALTHCHECK_URL`.

### 6.7 Restore — and the drill

Monthly, and before real customers:

1. S3 console → `lb-timesheets-backups` → `pg/<date>/` → download the newest
   `.dump.age` (the owner's own login; the backup key cannot read).
2. `ops/backup/restore-check.sh <file>.dump.age <path-to>.agekey` — needs
   Docker and age. It starts a throwaway PostgreSQL 18, streams the
   decrypted dump into it (no plaintext on disk), and prints the migration
   history, tables, constraints by kind, indexes, extensions and rows per
   table, then removes the container. It fails unless every migration is
   applied and none is unfinished.
3. A real recovery restores the same way into a NEW Railway Postgres
   service, then repoints `DATABASE_URL` — never over the live one.

## 7. Email — Amazon SES

The first deployment ran with `MAIL_TRANSPORT=disabled` until SES was
activated (2026-10-10, §7.1). With it disabled, the API starts
without AWS credentials, every send fails and is logged, and the startup log
says email is disabled. Registration cannot be completed then — expected for
an infrastructure test.

Prerequisites (STATUS.md says which are met): the `logisticbay.com`
identity verified in SES us-east-1; the account out of the SES sandbox; IAM
user `lb-timesheets-ses` with an inline policy allowing `ses:SendEmail` only
from the three senders, and no access key until go-live.

Bounces and complaints come from **Timesheets' own configuration set**,
never from identity notifications on `logisticbay.com`, which would fire for
every product sending as the domain (D58). Each step needs the owner's
approval at the time:

1. SES (us-east-1) → configuration set **`lb-timesheets`** — not the
   identity's default.
2. SNS (us-east-1) → standard topic **`lb-timesheets-ses-events`**; its
   access policy lets only `ses.amazonaws.com` publish, with
   `aws:SourceAccount` = this account and `aws:SourceArn` = the
   configuration set's ARN.
3. The configuration set → event destination: SNS, that topic, event types
   **Bounce** and **Complaint** only.
4. The API: set `SES_NOTIFICATION_TOPIC_ARN` to the topic's ARN and
   redeploy (the webhook exists only when it is set).
5. SNS → subscription: HTTPS,
   `https://api.timesheets.logisticbay.com/webhooks/ses`. The API confirms
   it itself, after verifying the signature, the topic and that the
   confirmation URL is SNS's.
6. IAM `lb-timesheets-ses`'s inline policy: also allow
   `arn:aws:ses:us-east-1:<account>:configuration-set/lb-timesheets` —
   `SendEmail` is authorised against the configuration set as well as the
   identity. The `ses:FromAddress` condition stays. The IAM policy simulator
   cannot evaluate configuration-set resources, so the first real send in
   step 7 is the proof: if it is refused `AccessDenied` on the configuration
   set, the fix is a SECOND statement allowing that ARN without the
   condition — the identity statement keeps the sender restriction, and
   every send must pass both.
7. Go live: create the access key → set `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=us-east-1`,
   `SES_CONFIGURATION_SET=lb-timesheets`, then `MAIL_TRANSPORT=ses` →
   redeploy → one test email, then the SES mailbox simulator
   (`bounce@simulator.amazonses.com`, `complaint@simulator.amazonses.com`)
   to prove the events arrive and are recorded once.

### 7.1 Production configuration — verified 2026-10-10

| Setting | Value |
|---|---|
| `MAIL_TRANSPORT` | `ses` |
| `AWS_REGION` | `us-east-1` |
| `SES_CONFIGURATION_SET` | `lb-timesheets` |
| `SES_NOTIFICATION_TOPIC_ARN` | `arn:aws:sns:us-east-1:463470971979:lb-timesheets-ses-events` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `lb-timesheets-ses`'s single access key — created by the owner in the console, entered only in Railway; never root's |

AWS: configuration set `lb-timesheets` (reputation metrics; not the
identity's default — the older default `my-first-configuration-set` has no
event destinations and was left alone); event destination
`lb-timesheets-bounces-complaints` (BOUNCE, COMPLAINT) → SNS topic
`lb-timesheets-ses-events`, whose policy admits only SES from this account
and this configuration set; one HTTPS subscription to
`https://api.timesheets.logisticbay.com/webhooks/ses`, confirmed by the API.
IAM `lb-timesheets-ses`: one statement — `ses:SendEmail` on the identity and
on the configuration set, From `accounts@`/`security@`/`timesheets@` only.
**The real sends proved it sufficient**: the two-statement fallback in step 6
was not needed.

Verified in production with synthetic accounts:

| Check | Result |
|---|---|
| Company verification email | delivered to Gmail **Inbox**; one send; link confirmed the account and created its company; a second use of the link refused |
| Password reset email | delivered to Inbox from `security@`; one send; the link reset the password, revoked the account's session in the same instant, and the old password is refused |
| Headers | `From: accounts@` / `security@logisticbay.com`, `Reply-To: support@logisticbay.com`, SPF pass (custom MAIL FROM `mail.logisticbay.com`), DKIM pass (`logisticbay.com`), DMARC pass |
| Links | `https://timesheets.logisticbay.com/…` |
| `bounce@simulator.amazonses.com` | hard bounce reached the webhook ~1 s after SES accepted the send; signature and topic accepted; one `EmailDeliveryEvent`; that address alone suppressed |
| `complaint@simulator.amazonses.com` | complaint recorded once; that address alone suppressed |
| Logs | no errors, no 5xx, no secret, address or token in any line |

The synthetic records left in production: company "ZZ SES Test Co 1
(synthetic)" with account `q25limited+ts-verify@gmail.com`, and two
unverified accounts at the simulator addresses (with their suppressions).
Removing them needs the owner's approval.

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
