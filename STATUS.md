# LogisticBay Timesheets — Status

> **This is the ONLY file allowed to describe what is currently built.**
> Other docs describe intent and must point here instead of asserting state.
> Last updated: 2026-08-25

Legend: ✅ done · 🔶 partial · 🔲 not started

---

## Overall

🔶 **Hardened foundation; still nothing a user can use.** No auth routes, no
shift flow, no PDF, no email sending, no web app, no mobile app.

What IS real: migration-managed schema with membership-bound shifts and a
one-open-shift invariant; a tenant-safe repository boundary with Company A/B
proofs; global error handling that cannot leak internals; fail-closed env
validation (CORS, JWT, email); a single authoritative gate (`npm run check`)
that CI runs verbatim, ending in a clean-database migrate-deploy + integrity
suite. Audit F-01…F-09 closed or consciously deferred; see audits/.

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
| Typecheck / lint / rules / dead-code guards | ✅ `npm run check` — tsc, eslint (type-aware), check-rules (15 checks), prisma validate, knip, 52 unit tests |
| Tenant-boundary rules | ✅ 4 mechanical rules, each independently unit-tested (`api/scripts/rules/tenantPatterns.ts`) |
| CORS integration proof | ✅ `app.inject()` tests — a foreign origin receives no `Access-Control-Allow-Origin` |
| Database tenant-integrity proof | ✅ 12/12 against a clean database built by `migrate deploy` (2026-08-30). Includes membership-binding (D15) and one-open-shift, on create AND update. Now INSIDE `npm run check` via `test:db` (provisions a clean `lb_timesheet_check` db + `migrate deploy` every run) — F-04 closed pending a green run |
| First migration | ✅ `api/prisma/migrations/20260830132905_init` — includes invariants.sql; `migrate deploy` proven on a clean database; partial index verified in pg_indexes |
| CI (GitHub Actions) | 🔶 runs on github.com/Q25ltd/LB-Timesheet; run #1 failed, workflow rewritten to `npm run check` — not yet re-verified green |
| Deployment | 🔲 — API to Railway, web to Vercel (D14). Neither connected. |
| Auth contract (AUTH.md) | ✅ frozen 2026-08-25 |
| Tenant repository boundary (F-01) | ✅ `TenantContext` + `shiftRepository`; 11 Company A/B tests |
| Outbox idempotency (F-09) | ✅ `SubmitJobStatus` enum + one row per shift, migration 2 |
| Rule-engine fixture tests (F-08) | ✅ `scripts/rules/engine.test.ts` — every rule proven wired |
| Email fail-closed in production (F-07) | ✅ SENDGRID_API_KEY + MAIL_FROM required unless explicitly dev/test |
| Auth implementation (login, select, switch, refresh, middleware) | 🔲 |
| Session model + refresh rotation | 🔲 |
| Multi-company driver memberships | 🔲 |
| Shift submission pipeline | 🔲 |
| PDF generation | 🔲 |
| Email delivery + retry outbox | 🔲 |
| Retention / deletion job | 🔲 — records are kept (D9); period + cancellation rule still open (O1) |
| Subscription enforcement | 🔲 |
| Driver activation-code onboarding | 🔲 |

## Known limitations / cleanup backlog

Tooling gaps that are accepted for now, not blocking, and not forgotten.

- **`route-declares-auth` static check has a parser gap (F-04, 2026-08-30).**
  `api/scripts/rules/routePatterns.ts`'s paren-depth matcher tracks nesting
  but not quote/string state (unlike `stripComments`). A route handler
  containing an unbalanced `(` inside a string or template literal can make
  the matcher's span overrun past the handler and pick up an unrelated
  `public:` key elsewhere in the file — a false negative where a genuinely
  undeclared route is silently treated as declared by the static check.
  **Not a runtime security gap**: the real enforcement boundary is the
  default-deny `onRequest` hook in `app.ts`, which has no such blind spot and
  rejects the request regardless of what the static check saw. Demonstrated
  with two constructed repro cases during F-04's adversarial review
  (2026-08-30); accepted as-is rather than expanding F-04's scope to harden a
  secondary guardrail. Cleanup: teach the paren matcher to track quote state
  the way `stripComments` already does.

---

## Infrastructure

| Area | State |
|---|---|
| Repo initialised (git) | ✅ `main` — **no commits yet** |
| API skeleton boots (`/health`) | ✅ verified on the Mac |
| First Prisma schema | ✅ pushed via `db:push` (no migration files yet) |
| Local Postgres (docker-compose, port 5544) | ✅ running |
| Dependencies installed | ✅ on the Mac, Node 22.12.0 |
| `timesheets.logisticbay.com` DNS | 🔲 |
| `timesheets-api.logisticbay.com` DNS | 🔲 |
| Database provisioned | 🔲 |
| Deployment pipeline | 🔲 |
| Marketing site menu linking both products | 🔲 |
