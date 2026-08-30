# LogisticBay Timesheets — Status

> **This is the ONLY file allowed to describe what is currently built.**
> Other docs describe intent and must point here instead of asserting state.
> Last updated: 2026-08-25

Legend: ✅ done · 🔶 partial · 🔲 not started

---

## Overall

🔶 **Skeleton running.** Repo initialised, schema pushed to a local database,
API boots and serves `/health`. Verified on the Mac 2026-08-25.

No auth, no shift flow, no PDF, no email, no web app, no mobile app yet — the
product does nothing a user could use.

Requires **Node 22.12+** (Prisma 7 breaks on Node 20); `.nvmrc` pins it.
Local Postgres runs on **port 5544**.

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
| Schema | ✅ core models — Company, User, CompanyMembership, Shift, ShiftSegment, ShiftSubmitJob |
| Typecheck / tests / dead-code guards | ✅ `npm run check` green end to end — tsc, check-rules (10 checks), knip, 10 unit tests. Verified on the Mac 2026-08-25 under Node 22.12.0 |
| CI (GitHub Actions) | 🔶 runs on github.com/Q25ltd/LB-Timesheet; run #1 failed, workflow rewritten to `npm run check` — not yet re-verified green |
| Deployment | 🔲 — API to Railway, web to Vercel (D14). Neither connected. |
| Auth contract (AUTH.md) | ✅ frozen 2026-08-25 |
| Auth implementation (login, select, switch, refresh, middleware) | 🔲 |
| Session model + refresh rotation | 🔲 |
| Multi-company driver memberships | 🔲 |
| Shift submission pipeline | 🔲 |
| PDF generation | 🔲 |
| Email delivery + retry outbox | 🔲 |
| Retention / deletion job | 🔲 — records are kept (D9); period + cancellation rule still open (O1) |
| Subscription enforcement | 🔲 |
| Driver activation-code onboarding | 🔲 |

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
