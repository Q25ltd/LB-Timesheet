# LogisticBay Timesheets — Status

> **This is the ONLY file allowed to describe what is currently built.**
> Other docs describe intent and must point here instead of asserting state.
> Last updated: 2026-08-31

Legend: ✅ done · 🔶 partial · 🔲 not started

---

## Overall

🔶 **Hardened foundation; still nothing a user can use.** No auth routes, no
shift flow, no PDF, no email sending, no web app, no mobile app.

What IS real: migration-managed schema with membership-bound shifts and a
one-open-shift invariant; the Session persistence foundation (the table and its
constraints only — see below); a tenant-safe repository boundary with Company
A/B proofs; global error handling that cannot leak internals; fail-closed env
validation (CORS, JWT, email); a single authoritative gate (`npm run check`)
that CI runs verbatim, ending in a clean-database migrate-deploy + integrity
suite. Findings F-01…F-11 and F-13 closed (F-12 reserved); see FINDINGS.md.

**A Session table is not authentication.** Nothing reads those columns yet: no
JWT verification, no `requireAuth`, no login, refresh, logout, company switch
or AuthContext. `requireAuth()` is still the stub that rejects every protected
request.

Requires **Node 22.13+** (`.nvmrc`). Local Postgres on **port 5544**.

---

## Fork inventory — what exists in the TMS and can be copied in

Surveyed 2026-08-25 from `~/timesheet-app` at `main` (669 commits). This is a
**reference list of source material**, not a list of things built here.

### Carries over with little change

| Piece | Where it lives in the TMS | Note |
|---|---|---|
| `Shift` model | `api/prisma/schema.prisma` | start/end time, break, POA, night out, expenses, defects note, status draft/submitted |
| `ShiftSegment` model | same | **already the asset-use segment concept** — truckReg, trailerReg, odometer start/end, start/end time, needsTruckCheck, needsTrailerCheck, checks as JSON |
| DVSA check definitions | `mobile/src/constants.ts` | 18-item tractor truck check, 10-item trailer check, separate rigid variant; pass/fail/na + note per item |
| Driver flow screens | `mobile/src/screens/` | StartShift, ChecklistScreen (truck+trailer), EndSegment, EndShift, Review, History, ShiftDetail |
| Mid-shift asset swap + re-check | `mobile/src/screens/ChangeVehicleScreen.tsx` | the §8/§9 behaviour, already working |
| PDF generation | `api/src/pdf.ts` (396 lines, PDFKit) | header, defect banner, shift details, hours summary, per-segment checks, mileage totals, driver declaration, footer |
| Email delivery | `api/src/email.ts` (SendGrid) | `sendShiftReportEmail`, defect-aware subject line |
| Reliable send + retry | `ShiftSubmitJob` model + `api/src/jobs/shiftSubmitWorker.ts` | outbox written in the same transaction as submit; worker drains it with exponential backoff, max attempts, pg advisory lock, idempotency. **Written after PDFs went missing on Railway redeploys — carry the solution, don't rediscover the bug.** |
| Offline queue | `mobile/src/offlineQueue.ts` | AsyncStorage-backed queue, retry/failure metadata |
| Destination email setting | `Company.reportEmail` / `reportEmailEnabled` | the company's "where do PDFs go" address |
| Auth shell | `LoginScreen`, `ChangePinScreen`, `AuthContext`, `api.ts` | pattern only — separate user table and secret here (D2) |

### Deliberately NOT copied

Jobs · JobDetail · Deliveries screens · `DeliveryTask` model · Holidays ·
`HolidayRequest` · `DriverAvailability` · `ShiftPreference` ·
`DriverWorkingTimeSummary` · planning · runs · customers · fleet · live routes.

### Debt NOT to inherit

- Shift models use `String @default("")` throughout — this repo uses `String?` (see CLAUDE.md).
- `pdf.ts` takes `shift: any` — this repo forbids `any`.
- Fuel/AdBlue are shift-level strings — see DECISIONS.md O6.
- The TMS PDF has a per-segment deliveries table — **not** copied here (see O2).

---

## Driver app

| Area | State |
|---|---|
| Start shift (date, time, driver, truck, trailer) | 🔲 |
| Company selection (only when driver holds >1 membership) | 🔲 |
| Truck check | 🔲 |
| Trailer check | 🔲 |
| Defect reporting (written description, no photo) | 🔲 |
| Mid-shift truck/trailer swap + required re-check | 🔲 |
| Mileage start / end | 🔲 |
| Fuel / AdBlue per unit | 🔲 — modelling open, see DECISIONS.md O6 |
| End shift, confirm, declaration/signature | 🔲 |
| Submit | 🔲 |
| Offline state + safe restart + duplicate protection | 🔲 |
| Personal salary/hours diary (private) | 🔲 — genuinely new, no TMS source |
| Personal history / statistics | 🔲 |

## Company web app

| Area | State |
|---|---|
| Company registration | 🔲 |
| Settings | 🔲 |
| Change password | 🔲 |
| Destination email for timesheets | 🔲 |
| Register drivers | 🔲 |
| Driver active / inactive | 🔲 |
| Subscription / billing | 🔲 — no TMS source, entirely new |
| Download copies of submitted shifts | 🔲 — regenerate, don't store (D7) |
| Check/form configuration | 🔲 |

## Backend

| Area | State |
|---|---|
| Schema | ✅ D15 shape — Shift bound to CompanyMembership by composite FK; ShiftStatus enum; validated, generated, migrated |
| Typecheck / lint / rules / dead-code guards | ✅ `npm run check` — generate, tsc, eslint (type-aware), check-rules (17 checks), prisma validate, knip, 89 unit tests, test:db integrity gate |
| Tenant-boundary rules | ✅ 4 mechanical rules, each independently unit-tested (`api/scripts/rules/tenantPatterns.ts`) |
| CORS integration proof | ✅ `app.inject()` tests — a foreign origin receives no `Access-Control-Allow-Origin` |
| Database tenant-integrity proof | ✅ 43/43 against a clean database built by `migrate deploy` (2026-08-31). Includes membership-binding (D15) and one-open-shift, on create AND update. Now INSIDE `npm run check` via `test:db` (provisions a clean `lb_timesheet_check` db + `migrate deploy` every run) — F-04 closed. |
| Migrations | ✅ 4 migrations, migration-managed bootstrap (no `db:push`) — `20260830132905_init` (schema + invariants.sql), `20260830150000_submit_job_status_enum_and_one_outbox_per_shift` (F-09), `20260830160000_membership_role_enum`, `20260831090000_session_persistence_foundation`; `migrate deploy` proven on a clean database; partial index verified in pg_indexes |
| CI (GitHub Actions) | 🔶 runs on github.com/Q25ltd/LB-Timesheet; run #1 failed, workflow rewritten to run `npm run check` verbatim. No workflow run has been independently verified for the current baseline (`86cd4e2`); its remote pass/fail result is unknown here. |
| Deployment | 🔲 — API to Railway, web to Vercel (D14). Neither connected. |
| Auth contract (AUTH.md) | ✅ frozen 2026-08-25 |
| Tenant repository boundary (F-01) | ✅ `TenantContext` + `shiftRepository`; 11 Company A/B tests |
| Outbox idempotency (F-09) | ✅ `SubmitJobStatus` enum + one row per shift, migration 2 |
| Rule-engine fixture tests (F-08) | ✅ `scripts/rules/engine.test.ts` — every rule proven wired |
| Email fail-closed in production (F-07) | ✅ SENDGRID_API_KEY + MAIL_FROM required unless explicitly dev/test |
| Default-deny route authentication (F-10) | ✅ closed — a root `onRequest` hook in `app.ts` rejects every route unless explicitly marked `public`. A secondary static guardrail (`route-declares-auth`) enforces explicit route posture in `check-rules`; the root runtime hook remains the security boundary. See "Known limitations" below for the guardrail's known parser gap. |
| Same-company driver isolation (F-11) | ✅ closed — driver-facing repository methods are scoped by `companyId` AND owning membership, not company alone; same-company driver-vs-driver isolation is proven by the DB integration suite (part of the 43/43 in "Database tenant-integrity proof" above). |
| Auth implementation (login, select, switch, refresh, middleware) | 🔲 |
| Session persistence foundation | ✅ P1.1 — a global `Session` owned by `User`, carrying NO company authority (no `companyId`, no `membershipId`); absolute `expiresAt` (90-day device lifetime, not extended by rotation); explicit `revokedAt`; current and optional previous refresh-token hash; previous-token grace deadline. Enforced by the database: unique current hash, unique non-null previous hash, CHECK `Session_previous_token_paired` (previous hash and grace deadline both NULL or both set), CHECK `Session_previous_token_distinct` (previous ≠ current), and `onDelete: Cascade` from User. Proven by 10 tests in `src/tests/db/sessionPersistence.test.ts`, written RED before the schema existed. **Persistence only — nothing reads these columns.** |
| Refresh-token rotation + grace-window behaviour | 🔲 — the columns exist; the logic does not |
| Multi-company driver memberships | 🔲 |
| Shift submission pipeline | 🔲 |
| PDF generation | 🔲 |
| Email delivery + retry outbox | 🔲 |
| Retention / deletion job | 🔲 — records are kept (D9); period + cancellation rule still open (O1) |
| Subscription enforcement | 🔲 |
| Driver activation-code onboarding | 🔲 |

## Known limitations / cleanup backlog

Tooling gaps that are accepted for now, not blocking, and not forgotten.

- **`route-declares-auth` static check has a parser gap (F-10, 2026-08-30).**
  `api/scripts/rules/routePatterns.ts`'s paren-depth matcher tracks nesting
  but not quote/string state (unlike `stripComments`). A route handler
  containing an unbalanced `(` inside a string or template literal can make
  the matcher's span overrun past the handler and pick up an unrelated
  `public:` key elsewhere in the file — a false negative where a genuinely
  undeclared route is silently treated as declared by the static check.
  **Not a runtime security gap**: the real enforcement boundary is the
  default-deny `onRequest` hook in `app.ts`, which has no such blind spot and
  rejects the request regardless of what the static check saw. Demonstrated
  with two constructed repro cases during F-10's adversarial review
  (2026-08-30); accepted as-is rather than expanding F-10's scope to harden a
  secondary guardrail. Cleanup: teach the paren matcher to track quote state
  the way `stripComments` already does.

---

## Infrastructure

| Area | State |
|---|---|
| Repo initialised (git) | ✅ `main` — active repository; current baseline `86cd4e2` |
| API skeleton boots (`/health`) | ✅ verified on the Mac |
| First Prisma schema | ✅ migration-managed (4 migrations; see "Migrations" row under Backend) — `db:push` bootstrapping was retired |
| Local Postgres (docker-compose, port 5544) | ✅ running |
| Dependencies installed | ✅ on the Mac; Node 22.13.0 (via `nvm use`, matching `.nvmrc`), npm 10.9.2 |
| `timesheets.logisticbay.com` DNS | 🔲 |
| `timesheets-api.logisticbay.com` DNS | 🔲 |
| Database provisioned | 🔲 |
| Deployment pipeline | 🔲 |
| Marketing site menu linking both products | 🔲 |
