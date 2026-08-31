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
one-open-shift invariant; Session persistence; protected-request authentication
(P1.2a — see below); a tenant-safe repository boundary with Company A/B proofs;
global error handling that cannot leak internals; fail-closed env validation
(CORS, JWT, email); a single authoritative gate (`npm run check`) that CI runs
verbatim, ending in a clean-database migrate-deploy + integrity suite. Findings
F-01…F-11, F-13 and F-14 closed; F-15…F-21 opened or deferred by the 2026-08-31
backend foundation audit (F-12 reserved); see FINDINGS.md.

**Independently audited 2026-08-31** against `0591241`: **0 Critical, 0 High**,
5 Medium, 4 Low, 4 Observation. No authentication bypass, no cross-company
escape and no same-company driver-to-driver escape was demonstrated. The audit
did not invalidate P1.2a. What it did establish is what must come next — see
"Blocked until" below.

**Authentication verifies identity; nothing issues one.** `requireAuth` is no
longer a stub — a request carrying a valid token, a live Session and a matching
CompanyMembership now reaches a route with a trusted AuthContext. But **no code
mints a token**: there is no login, no refresh rotation, no logout, no company
selection or switching, and no route that reads `request.auth`. No driver can
obtain a token through this product today.

**Authorization now exists above authentication (P1.2b).** The AuthContext →
TenantContext bridge is built: `authorizeTenant` turns an authenticated active
membership into tenant repository authority, and denies an inactive one with a
generic `403 FORBIDDEN` (D17). What is *not* built is AUTH.md's narrow
exception — the limited operations a deactivated membership keeps on an
already-open shift. See the P1.2b rows below.

**P1.2b independently audited 2026-08-31** against `60effc9`, read-only, by an
auditor that did not implement it: **0 Critical, 0 High, 0 Medium**, 2 Low, 4
Observation. Verdict *pass with non-blocking findings* — the claimed invariant
held under 19 adversarial probes, including cross-user membership forgery, a
session belonging to another user, foreign `iss`/`aud` values, `alg:none`,
hostile tenant identity in body/query/path/headers, nine non-`active`
membership states, property smuggling, mid-token deactivation and a route
wrongly marked public. The authoritative gate ran green at this SHA (110/110
unit, 45/45 DB, 4 migrations). Opened **F-22** (the `TenantContext` brand is
compile-time only), **F-23** (the trust-site rule's exemption is broader than
documented) and **F-24** (the two user-binding checks have no test). None
blocks P1.2b, the first protected business route, or deployment.

**Blocked until.** The *first protected business route* is blocked by the
still-open **O8** filing-date/timezone decision — and, since `2c85f4f`, by that
alone; P1.2b (F-14) no longer blocks it. *Public deployment* is blocked by at
least the rate-limit/proxy architecture (F-15) and the production `tsx` runtime
(F-17). **Development itself is not blocked** — login/token-minting groundwork
may proceed.

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
| Typecheck / lint / rules / dead-code guards | ✅ `npm run check` — generate, tsc, eslint (type-aware), check-rules (17 checks), prisma validate, knip, 110 unit tests, test:db integrity gate |
| Tenant-boundary rules | ✅ 4 mechanical rules, each independently unit-tested (`api/scripts/rules/tenantPatterns.ts`) |
| CORS integration proof | ✅ `app.inject()` tests — a foreign origin receives no `Access-Control-Allow-Origin` |
| Database tenant-integrity proof | ✅ 45/45 against a clean database built by `migrate deploy` (2026-08-31). Includes membership-binding (D15) and one-open-shift, on create AND update, plus the two persisted protected-request proofs (P1.2a). Now INSIDE `npm run check` via `test:db` (provisions a clean `lb_timesheet_check` db + `migrate deploy` every run) — F-04 closed. |
| Migrations | ✅ 4 migrations, migration-managed bootstrap (no `db:push`) — `20260830132905_init` (schema + invariants.sql), `20260830150000_submit_job_status_enum_and_one_outbox_per_shift` (F-09), `20260830160000_membership_role_enum`, `20260831090000_session_persistence_foundation`; `migrate deploy` proven on a clean database; partial index verified in pg_indexes |
| CI (GitHub Actions) | ✅ runs on github.com/Q25ltd/LB-Timesheet, executing `npm run check` verbatim (run #1 failed against the original workflow, which was then rewritten). Remote results were independently queried from the GitHub Actions API on 2026-08-31 and are `completed/success` for every commit checked: `5641691` (P1.2a), `0591241`, `2c85f4f` (P1.2b), `60effc9` and `d1f0c1b`. This states what those five runs returned — it is not a claim about any other commit. |
| Deployment | 🔲 — API to Railway, web to Vercel (D14). Neither connected. **Public deployment is additionally blocked by F-15** (auth-before-rate-limit + unreviewed proxy trust) **and F-17** (production `npm start` runs `tsx`, a devDependency). |
| Auth contract (AUTH.md) | ✅ frozen 2026-08-25 |
| Tenant repository boundary (F-01) | ✅ `TenantContext` + `shiftRepository`; 11 Company A/B tests |
| Outbox enqueue uniqueness (F-09) | ✅ `SubmitJobStatus` enum + one row per shift, migration 2 — this is **storage/enqueue uniqueness only**. Transaction atomicity of transition-plus-enqueue, worker-claim idempotency and exactly-once external email delivery are **not** proven; see **F-16**. Do not describe this row as "submission idempotency". |
| Rule-engine fixture tests (F-08) | ✅ `scripts/rules/engine.test.ts` — every rule proven wired |
| Email fail-closed in production (F-07) | ✅ SENDGRID_API_KEY + MAIL_FROM required unless explicitly dev/test |
| Default-deny route authentication (F-10) | ✅ closed — a root `onRequest` hook in `app.ts` rejects every route unless explicitly marked `public`. A secondary static guardrail (`route-declares-auth`) enforces explicit route posture in `check-rules`; the root runtime hook remains the security boundary. See "Known limitations" below for the guardrail's known parser gap. |
| Same-company driver isolation (F-11) | ✅ closed — driver-facing repository methods are scoped by `companyId` AND owning membership, not company alone; same-company driver-vs-driver isolation is proven by the DB integration suite (part of the 45/45 in "Database tenant-integrity proof" above). |
| Protected-request authentication (P1.2a) | ✅ — `requireAuth` verifies a Bearer JWT (HS256 pinned; issuer `logisticbay-timesheets`; audience `timesheets-api`; `iat`/`exp`/`iss`/`aud` required by the verifier, `sub`/`companyId`/`membershipId`/`sessionId` by the claims schema), enforces the frozen declared lifetime `0 < exp - iat <= 900s`, then requires a persisted Session (present, not revoked, not past its absolute expiry, `userId === sub`) and a persisted CompanyMembership (present, `userId === sub`, `companyId === token.companyId`). The token's `companyId` is cross-checked against the row and never authority on its own — the AuthContext company comes from the persisted membership, and `role` is read fresh from that row on every request. Produces exactly `{ userId, companyId, membershipId, sessionId, role, membershipStatus }`. Every failure is the identical `401 { "error": "Not authenticated", "code": "UNAUTHENTICATED" }`, so the boundary is not an oracle for which check failed. Database access is the narrow `AuthStore` (two primary-key reads, records rebuilt field by field) — `requireAuth` never receives a PrismaClient or `AppDatabase`. Proven by 16 pipeline tests (`src/lib/auth.test.ts`, each negative paired with a positive control) and 2 tests against real persisted rows (`src/tests/db/authProtectedRequest.test.ts`). |
| Auth routes — login, company select, company switch, refresh, logout, token minting | 🔲 — nothing in this product issues a token; the verifier is configured for `verify` only. **F-19** (a far-future `iat` is currently accepted) must be resolved before this work is accepted complete |
| **P1.2b — Authorized Tenant Context** | ✅ — F-14 closed in `2c85f4f`. `authorizeTenant(auth: AuthContext): TenantContext` (`api/src/lib/authorization.ts`) is the one production place authenticated identity becomes tenant authority, and the only production caller of `TenantContext.trust()`. It takes the trusted `AuthContext` and **nothing else** — no `companyId`, `membershipId`, `userId`, `role`, request, body, query or options parameter — so client-supplied identity has no channel to arrive through; and it performs **no database read**, because `requireAuth` already validated the identity against persistence. Active membership → a `TenantContext` carrying `companyId`, `userId` **and** `membershipId` (all three; `membershipId` is what `shiftRepository` scopes `findById`/`update`/`delete` on, per D15). Anything not exactly `"active"` → generic `403 FORBIDDEN` (D17); the comparison is `!== "active"`, so a future third membership state would fail closed. Proven by 5 tests in `api/src/lib/authorization.test.ts`, written RED and reviewed before implementation; `npm run check` exit 0 at `2c85f4f` (110/110 unit, 45/45 DB, 4 migrations). The static rules were **not** changed: `tenant-context-trust-sites` already permitted `lib/auth*`, so the bridge needed no rule change. That exemption is an unanchored path substring and its coverage is narrower than earlier wording here claimed — see **F-23**. Independently audited 2026-08-31 against `60effc9`: the P1.2b invariant held under every attack constructed against it (no inactive bypass, no role bypass, no alternate construction path, no client channel through body, query, path params or headers); the audit opened **F-22**, **F-23** and **F-24**, none of which invalidates this row. |
| Inactive-membership authorization — **ordinary/default rule** | ✅ — the default-deny half of AUTH.md's "Deactivated membership" section is implemented: an inactive membership still authenticates and is reported as `inactive` (P1.2a, unchanged), and is then refused ordinary tenant authority with `403 { "error": "Not allowed", "code": "FORBIDDEN" }`. Generic on purpose — the response never discloses that a deactivated membership caused the denial (D17). Role is not a bypass: an inactive **admin** is denied identically. |
| Inactive-membership authorization — **the narrow exception** | 🔲 — AUTH.md permits a deactivated membership to read, update and submit an **already-open** shift, and nothing else. **None of that exists.** There is no finalise capability, no discard capability, no `allowInactive`, no bypass flag, no capability token, no permission enum and no policy engine. Its concrete API is an open design question, not a settled one; the only frozen fact is that any such operation must be explicit and narrow. It will be designed with the business feature that needs it. |
| First protected business route | 🔲 — **no longer blocked by P1.2b (F-14), closed `2c85f4f`.** Still blocked by O8, which must be decided before `shiftDate` can be persisted correctly (a local 00:30 BST start can fall on the previous UTC date). Owner decision required; see DECISIONS.md O8 |
| Session persistence foundation | ✅ P1.1 — a global `Session` owned by `User`, carrying NO company authority (no `companyId`, no `membershipId`); absolute `expiresAt` (90-day device lifetime, not extended by rotation); explicit `revokedAt`; current and optional previous refresh-token hash; previous-token grace deadline. Enforced by the database: unique current hash, unique non-null previous hash, CHECK `Session_previous_token_paired` (previous hash and grace deadline both NULL or both set), CHECK `Session_previous_token_distinct` (previous ≠ current), and `onDelete: Cascade` from User. Proven by 10 tests in `src/tests/db/sessionPersistence.test.ts`, written RED before the schema existed. Since P1.2a the pipeline reads existence, `revokedAt`, `expiresAt` and `userId` on every protected request; the refresh-token columns and the grace deadline remain unread — no rotation logic exists. |
| Refresh-token rotation + grace-window behaviour | 🔲 — the columns exist; the logic does not. **F-21** (cross-column refresh-hash ambiguity) must be decided before this is implemented |
| Multi-company driver memberships | 🔲 |
| Shift submission pipeline | 🔲 — F-16 (atomicity / worker claim / exactly-once delivery) must be resolved as part of this boundary |
| PDF generation | 🔲 |
| Email delivery + retry outbox | 🔲 |
| Retention / deletion job | 🔲 — records are kept (D9); period + cancellation rule still open (O1) |
| Subscription enforcement | 🔲 |
| Driver activation-code onboarding | 🔲 — F-18 (`Company.joinCode` is a permanent plaintext credential) must be resolved as part of this boundary |

## Known limitations / cleanup backlog

Accepted gaps and deliberate trade-offs — not blocking, and not forgotten.

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

- **`no-company-id-in-dto` exempts the token-verification modules (P1.2a,
  2026-08-31).** The rule could not tell an untrusted client DTO declaring
  `companyId` from the verified access-token claims schema, which legitimately
  declares one. It now skips exactly the modules where `jwt-centralised`
  already confines token verification — today that is `src/lib/auth.ts` alone
  (the pattern also covers a `src/lib/tokens.ts`, which does not exist yet), an
  enforced boundary rather than a directory or a schema name. Client DTOs are
  still reported everywhere else, including shared modules a route imports;
  both sides are proven by good/bad fixtures in `scripts/rules/engine.test.ts`.
  Scoping the rule to `routes/` + `services/` was rejected because nothing
  confines a request DTO to those directories. **Residual limitation:** a
  request DTO deliberately placed inside a token-verification module would
  escape this specific rule. It remains a static pattern guardrail, not a
  security proof (D16); the runtime boundary is `requireAuth` itself.

- **Authentication runs before rate limiting (deliberate, P1.2a).** The
  default-deny `onRequest` hook is registered after `cors` and before
  `rateLimit`, so a rejected request is denied without spending a rate-limit
  slot. The trade-off is that signature verification and the two identity
  reads happen before any rate limit applies. Accepted; revisit if abuse of
  unauthenticated verification ever becomes a concern.

- **`request.auth` is optional at the Fastify type level (P1.2a).** Declared
  `auth?: AuthContext` because a public route never runs `requireAuth`, so a
  non-optional declaration would be false on exactly the routes where being
  wrong matters most. Every future protected route must therefore narrow it.
  Revisit when the first route consumes it.

- **`db-check` can force-drop a fixed database name (audit 2026-08-31, Low).**
  `api/scripts/db-check.ts:56` runs `DROP DATABASE IF EXISTS
  "lb_timesheet_check" WITH (FORCE)` against whatever server `DATABASE_URL`
  points at. The naming convention is not a structural safety barrier — unlike
  `db-smoke`, which refuses to run outside `development`/`test` and outside the
  two local database names. Non-blocking backlog; direction is to mirror those
  guards or require an explicit destructive-test sentinel. No canonical finding
  ID; tracked in FINDINGS.md's "Known sub-issues" section.

- **`AuthStore` over-fetches the Session row (audit 2026-08-31, Low).**
  `api/src/lib/authStore.ts:62` reads the whole row — refresh-token hashes
  included — then rebuilds a four-field record in memory. Defence in depth
  rather than a demonstrated leak: nothing above the adapter sees Prisma.
  Non-blocking backlog; direction is an explicit Prisma `select`, when that
  boundary is next touched under owner authorization.

- **Three of the four tenant rules currently scan zero production files (P1.2b
  audit, 2026-08-31, Observation).** `src/routes/` and `src/services/` do not
  exist yet, so `no-client-tenant`, `no-raw-request-past-route` and
  `no-request-in-services` are today proven only against `__fixtures__`.
  Correct and expected at this stage — recorded so that "4 tenant-boundary
  rules ✅" is not read as "4 rules currently guarding production code". No
  action; it resolves itself when the first route lands.

- **Company-level state is never consulted on the authority path (P1.2b audit,
  2026-08-31, Observation).** `Company.status` (`trial | active | past_due |
  cancelled`) is read by nothing, and there is no global `User.active`, so an
  active member of a cancelled company retains full tenant authority.
  Known-not-built — "Subscription enforcement 🔲" below owns it. Recorded here
  only because `authorizeTenant` is the single chokepoint such enforcement will
  have to land in, rather than in individual routes.

- **Stale comments and config outside documentation scope (audit 2026-08-31).**
  Five reconciliation items found by the audit that live in **code, tests or
  config**, and so could not be corrected by a documentation-only task. Not
  defects in behaviour; each is a comment or a range that no longer matches
  reality. Awaiting an authorized code-scope pass:
  1. `api/prisma/schema.prisma:94` — the Session model comment still says
     "Persistence only. Nothing in this repo reads these columns yet", and
     lists `requireAuth` and JWT verification as unbuilt. P1.2a made this false.
  2. `api/src/tests/db/repositoryTenantBoundary.test.ts:199` — comment still
     says driver-facing methods are "scoped by `companyId` alone, so driver A2
     can currently reach driver A's data". F-11 fixed that; the test now proves
     the opposite of what its comment describes.
  3. `api/prisma/schema.prisma:303` and
     `api/src/tests/db/tenantIntegrity.test.ts:284` — both describe one-row-per-
     shift uniqueness as the "idempotency guarantee" / "submits are idempotent".
     That is enqueue uniqueness only (F-16). The STATUS row above has been
     corrected; the code comments have not.
  4. `api/scripts/first-migration.sh:99` — names `lb_timesheet_migrate_test`,
     while `test:db` uses `lb_timesheet_check`.
  5. `api/package.json:50` and `package.json:24` — `engines.node` is
     `>=22.12.0`, while `.nvmrc`, CI and `check-rules` all require 22.13.
  6. `api/src/lib/auth.ts:115` — `requireAuth`'s doc comment still says "the 403
     rules that act on that belong to routes and services, **which do not exist
     yet**". P1.2b made the second half false: the ordinary 403 rule now exists,
     in `api/src/lib/authorization.ts`. The comment was left untouched because
     the reconciliation task that found it was documentation-only. Behaviour is
     unaffected.
  7. `api/src/lib/tenantContext.ts:6-8` — the class comment says "The single way
     to obtain one is `TenantContext.trust()`". A deliberate `as unknown as
     TenantContext` defeats that, and the instance is not frozen, so `readonly`
     is compile-time only. Tracked as **F-22**; the comment is listed here too
     because it is the artifact a future agent reads at the moment it matters.

---

## Infrastructure

| Area | State |
|---|---|
| Repo initialised (git) | ✅ `main` — active repository; Git and the live remote own the current baseline (AGENT_WORKFLOW.md §2) |
| API skeleton boots (`/health`) | ✅ verified on the Mac |
| First Prisma schema | ✅ migration-managed (4 migrations; see "Migrations" row under Backend) — `db:push` bootstrapping was retired |
| Local Postgres (docker-compose, port 5544) | ✅ running |
| Dependencies installed | ✅ on the Mac; Node 22.13.0 (via `nvm use`, matching `.nvmrc`), npm 10.9.2 |
| `timesheets.logisticbay.com` DNS | 🔲 |
| `timesheets-api.logisticbay.com` DNS | 🔲 |
| Database provisioned | 🔲 |
| Deployment pipeline | 🔲 |
| Marketing site menu linking both products | 🔲 |
