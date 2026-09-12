# LogisticBay Timesheets — Status

> **This is the ONLY file allowed to describe what is currently built.**
> Other docs describe intent and must point here instead of asserting state.
> Last updated: 2026-09-11 (Registration completed on device)

Legend: ✅ done · 🔶 partial · 🔲 not started

---

## Overall

🔶 **The complete driver AUTHENTICATION experience is built and green in the
gate — register, log in, stay logged in across restarts, unlock with Face ID /
Touch ID / Android biometrics, select a company, and log out with server-side
revocation.** Registration was approved on a physical phone on 2026-09-11; the
rest is proven by tests and **awaits owner device acceptance**. Beyond
authentication a driver still cannot do anything: no vehicle/check flow, no
start-shift UI, no finish, no PDF, no email sending, no web app.

What IS real: migration-managed schema with membership-bound shifts, a
one-open-shift invariant, a non-null company IANA timezone (D18) and offline
Start Shift identity; Session persistence; protected-request authentication
(P1.2a — see below); **the Start Shift backend foundation — `POST /shifts/start`
and `GET /shifts/current` (D19, D20)**; **Registration Increment 1 — `POST
/auth/register` and `GET /auth/me`, the identity token, the three route
postures, and an Expo driver app whose Registration screen calls the real
API**; a tenant-safe repository boundary with Company A/B proofs;
global error handling that cannot leak internals; fail-closed env validation
(CORS, JWT, email); a single authoritative gate (`npm run check`) that CI runs
verbatim, covering both workspaces and ending in a clean-database
migrate-deploy + integrity suite. Findings
F-01…F-11, F-13, F-14, **F-19** and **F-21** closed; F-15…F-18 and F-20 open or
deferred, F-22 partial, F-23 open (F-12 reserved); see FINDINGS.md.

**An INDEPENDENT full-authentication audit is the next step.** This phase was
implemented and self-verified by the same agent, which is not an audit. A fresh
security agent must review the complete authentication system before any
further inside-app feature work.

**Independently audited 2026-08-31** against `0591241`: **0 Critical, 0 High**,
5 Medium, 4 Low, 4 Observation. No authentication bypass, no cross-company
escape and no same-company driver-to-driver escape was demonstrated. The audit
did not invalidate P1.2a. What it did establish is what must come next — see
"Blocked until" below.

**The authentication lifecycle is complete (2026-09-11).** `POST /auth/register`,
`POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` and
`POST /auth/switch-company` all exist, with identity/tenant audience separation
intact. A refresh secret is redeemable, rotation is atomic and conditional, the
60-second recovery grace works, reuse outside it revokes the session, and the
mobile app restores a session at startup behind an optional biometric gate.
**F-21 is CLOSED** — the ambiguous cross-column lookup is now unrepresentable
in the refresh repository's database interface, with no schema change. See the
auth rows below for exactly what each piece does and does not prove.

**NOT YET PHYSICALLY VERIFIED — a pre-release gate, not a blocker on
development (owner decision, 2026-09-11).** Login's *layout* was approved on
the phone. The following are proven by automated and architectural evidence
only, and must be validated on real hardware before any release:

- Face ID
- Touch ID
- Android biometric authentication
- iOS password AutoFill
- Android credential AutoFill
- native cold-start biometric restoration
- store / dev-build permission behaviour

An attempt on 2026-09-11 (`npx expo run:ios --device`) could not run: both
iPhones were offline to Xcode and **no iOS simulator runtime is installed**, so
Expo's device picker was empty and crashed on `undefined.udid`. Earlier runs
used **Expo Go**, which has no `NSFaceIDUsageDescription` and therefore cannot
exercise Face ID at all. Nothing about the implementation was invalidated; it
simply has not been observed on a device.

The mobile workspace is **Expo managed / prebuild** (D25): `mobile/ios/` and
`mobile/android/` are generated and gitignored, and `app.json` plus the config
plugins are the authority. The generated `Info.plist` was confirmed to carry
`NSFaceIDUsageDescription`; the generated entitlements file is **empty**, so
there is no Associated Domains entitlement and iOS will offer credentials
saved *in this app* but nothing shared from Safari — that needs a real domain
and an `apple-app-site-association` file, and stays deferred.

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
documented) and **F-24** (the two user-binding checks had no test — **CLOSED
2026-09-09**, see below). None blocks P1.2b, the first protected business
route, or deployment.

**F-22 is now PARTIAL, not closed.** Its runtime-mutation half was fixed in
`c742b03` — `TenantContext` freezes itself in the constructor, so an authority
field can no longer be reassigned, redefined, extended or deleted, and a write
throws instead of silently doing nothing. Its forgery half stands and is not
fixable in TypeScript: `as unknown as TenantContext` still manufactures one. The
source no longer contradicts that — the class comment says *sanctioned* rather
than *only* and points at D16 — but whether the forgery half stays outstanding
or is recorded as `ACCEPTED` under D16 is an open owner disposition. F-23 is
untouched. **F-24 was closed on 2026-09-09** in `597bd111` — see the
protected-request row below.

**Blocked until.** The *first protected business route* is **no longer blocked by
an open decision**: P1.2b (F-14) stopped blocking it at `2c85f4f`, and **O8 was
decided on 2026-08-31 as D18** — one timesheet per shift, filed under the local
calendar date it started, in the company's IANA timezone. D18's data-model
prerequisite is now **built**: `Company.timezone` exists, non-null, defaulted to
`Europe/London` for V1 (`4888d63`), and a pure helper derives the local calendar
date from an instant plus that zone. The route itself is now **built** — see the
"Start Shift backend foundation" row below; two schema facts named there remain
unbuilt (`shiftDate` immutability enforcement and Night Out). *Public
deployment* is blocked by at
least the rate-limit/proxy architecture (F-15) and the production `tsx` runtime
(F-17) — and registration and `/auth/register` being live locally does not
change that: they are the product's first public mutating routes and sit
behind the same flat 300/min/IP limit F-15 describes. **Refresh-token rotation is no longer blocked** — F-21 was closed on
2026-09-11 and rotation is built. **Development itself is not blocked.**

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

The Expo workspace exists (`mobile/`) — React Native + Expo SDK 57 +
TypeScript strict, `expo-router`, `expo-secure-store`. It participates in the
root `npm run check` (typecheck, lint, 100 tests), so it cannot rot unnoticed.
**No SQLite yet** (D25) — that arrives with offline/personal data.

**Run the gate from the repository root.** The api-local `check` script is
narrower and silently skips mobile and the database; running it by mistake is
the one way to believe the gate passed when it did not.

| Area | State |
|---|---|
| Driver registration (first name, last name, email, password) | ✅ — **manually approved on a physical phone by the owner, 2026-09-11**. A real screen calling the real `POST /auth/register`: validation, show/hide on both password fields, submitting and disabled states, field-level and form-level errors, a distinct no-connection state, `409 EMAIL_IN_USE` in the driver's words, safe areas, ≥44pt targets. A fifth box — **Repeat password** — is validated client-side and is deliberately NOT a request field: the DTO is four fields and `.strict()`, so a fifth is refused `400`; the request is built field by field, never by spreading form state, and a test asserts the exact body. The password rule renders INSIDE the password field rather than on a line between the two password inputs. The hero photograph is integrated edge to edge |
| Registration layout | ✅ — at rest the form fits with **no scrolling in either direction** (`scrollEnabled={false}`, `flexGrow: 1`, bounce off). The hero shrinks on shorter screens and is dropped entirely below 720pt or while the keyboard is up. Scrolling is enabled **only** with the keyboard covering the screen, because the alternative there is fields the driver cannot reach. Form height ≈592pt; proven by 4 layout tests |
| Mobile → API host resolution | ✅ — the API host is derived from the Metro dev server the bundle was loaded from (`Constants.expoConfig.hostUri`), so a physical phone and both simulators work with no per-machine configuration. `EXPO_PUBLIC_API_URL` overrides it and is required for any build Metro does not serve. **A connection failure in development names the URL it tried**; that detail is null in a production build, so no internal hostname reaches a driver. 6 tests. The previous per-platform default resolved to `localhost` on a phone — which is the phone — and reported as "check your signal" |
| Signed-in state with ZERO companies | ✅ — after registering, the driver enters an authenticated shell that states the account is ready and that no company is linked. No join-company gate, no error, no fake membership. Proven by the screen suite and by a live end-to-end run that created 0 Company and 0 CompanyMembership rows |
| Session material handling | ✅ — unchanged by the registration completion. Refresh secret in `expo-secure-store` under one key; identity token **in memory only**; nothing in AsyncStorage; the password is never persisted. The storage module exposes no generic setter, and one of its 4 tests asserts its export list |
| Login screen | ✅ — the real screen, Registration's visual sibling from the shared `authLayout` (same `Brand`, `Field`, `PrimaryButton`, theme, hero, scroll contract and short-screen threshold). Email + password + show/hide + Sign in + "Create account". The brand lockup sits at the TOP of the white area, exactly where Registration's does; everything BELOW it — heading, fields, button, footer — is VERTICALLY CENTRED in the remaining space (owner corrections, physical phone) by one flex property applied to this screen only. Registration's top-aligned layout is untouched, and tests pin both facts. No "Keep me signed in", no company field, no Forgot Password (recovery does not exist). A secondary biometric action appears only when the device is genuinely eligible. 31 tests. **Layout approved on the phone; the biometric action has not been seen on hardware** |
| Platform credential AutoFill | ✅ (code) / 🔲 (device-verified) — both forms declare the credential pair the OS password manager reads: the account field is `textContentType="username"` + `autoComplete="email"` and the password fields are `password`/`current-password` on Login and `newPassword`/`new-password` on Registration, all with `importantForAutofill="yes"`. **Registration previously used `textContentType="emailAddress"`**, a CONTACT hint, so iOS never had a username to pair with the password it was asked to save and Login had nothing to suggest — that was the defect the owner reported. 8 tests assert the rendered hints and their pairing. The app itself persists **no** password: `secureStore.ts` exports six named functions, none of them a credential the user typed, and no generic setter. **AutoFill actually appearing is an OS behaviour and is NOT proven by these tests** — see the pre-release list above |
| Session restore after app restart | ✅ — at startup the app reads the SecureStore secret, applies the biometric gate when opted in, redeems it through `/auth/refresh`, **replaces the rotated secret**, reads `/auth/me`, and only then becomes authenticated. `AuthProvider` has an explicit `restoring` status and `app/index.tsx` HOLDS on it, so there is no sign-in flash. A refused credential is deleted; an OFFLINE failure KEEPS it, because a tunnel is not a logout. Company authority is never restored — a tenant token is never stored |
| Start shift (date, time, driver, truck, trailer) | 🔲 — **mobile UI**. The backend it will call exists (see Backend, "Start Shift backend foundation"); no screen, no offline queue, no time picker and no ±15-minute confirmation (D20) is built |
| Company selection (only when driver holds >1 membership) | 🔶 — the SERVER endpoint and the client call exist and are proven; there is no picker SCREEN yet, and nothing can create a second membership to pick from |
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
| Schema | ✅ D15 shape — Shift bound to CompanyMembership by composite FK; ShiftStatus enum; `Shift.clientEventId` (nullable) with `@@unique([membershipId, clientEventId])` for offline Start Shift identity (D19). **`User` now carries `firstName` + `lastName` (both NOT NULL) and `email` is `citext`** with one unique index (D22) — `User.name` is gone, not retained alongside. Validated, generated, migrated |
| Typecheck / lint / rules / dead-code guards | ✅ `npm run check` **from the repo root** — generate, tsc, eslint (type-aware, both workspaces), check-rules (17 checks), prisma validate, knip, 177 api unit tests, **mobile typecheck + 100 mobile tests**, test:db integrity gate. The api-local `check` script is narrower and skips mobile and the database; running it by mistake is the one way to think the gate passed when it did not |
| Tenant-boundary rules | ✅ 4 mechanical rules, each independently unit-tested (`api/scripts/rules/tenantPatterns.ts`) |
| CORS integration proof | ✅ `app.inject()` tests — a foreign origin receives no `Access-Control-Allow-Origin` |
| Database tenant-integrity proof | ✅ 85/85 against a clean database built by `migrate deploy` (71 → 85 at Registration Increment 1, the fourteen added being registration's — schema shape, citext uniqueness at raw-SQL level, persistence, session, zero-membership, duplicate/concurrency and identity-token cases). Previously 71/71 (45 → 50 at `4888d63`, the five added being the company timezone authority's; 50 → 71 at Start Shift, the twenty-one added being that route's — see its row below). Includes membership-binding (D15) and one-open-shift, on create AND update, plus the two persisted protected-request proofs (P1.2a). Now INSIDE `npm run check` via `test:db` (provisions a clean `lb_timesheet_check` db + `migrate deploy` every run) — F-04 closed. |
| Migrations | ✅ **8** migrations, migration-managed bootstrap (no `db:push`) — `20260830132905_init` (schema + invariants.sql), `20260830150000_submit_job_status_enum_and_one_outbox_per_shift` (F-09), `20260830160000_membership_role_enum`, `20260831090000_session_persistence_foundation`, `20260831210000_company_timezone_authority` (D18), `20260909120000_shift_client_event_identity` (D19 — nullable `clientEventId` + its unique index; proven on a clean database AND as an upgrade of a populated one, pre-existing Shift rows keeping NULL, no backfill), **`20260910120000_user_identity_names`** (D22 — `firstName`/`lastName` added nullable, deterministic backfill splitting on the FIRST space so `"John van der Berg"` keeps its surname intact, a guard that **ABORTS** on any name that cannot yield both halves, then NOT NULL and `DROP COLUMN name`), **`20260910130000_user_email_citext`** (D22 — `CREATE EXTENSION citext`, a collision guard that ABORTS before any write, normalise to trim+lowercase, then `ALTER COLUMN email TYPE citext`, leaving exactly one unique index). Both new migrations proven **twice**: clean install inside `npm run check`, and a populated upgrade from the 6-migration baseline on throwaway databases — `"John Smith"`, `"John van der Berg"` and a padded mixed-case email all converted correctly, while a one-word name and a pair of case-colliding emails each aborted their migration with a named reason and left every row intact; `migrate deploy` proven on a clean database; partial index verified in pg_indexes. The local development database has the first five applied (`migrate deploy`, 2026-08-31); migration 6 has not been applied to it |
| CI (GitHub Actions) | ✅ runs on github.com/Q25ltd/LB-Timesheet, executing `npm run check` verbatim (run #1 failed against the original workflow, which was then rewritten). Remote results were independently queried from the GitHub Actions API on 2026-08-31 and are `completed/success` for every commit checked: `5641691` (P1.2a), `0591241`, `2c85f4f` (P1.2b), `60effc9` and `d1f0c1b`. This states what those five runs returned — it is not a claim about any other commit. Queried again for `4888d63` (company timezone authority): run `33436174195`, `completed/success`, `headSha` matching that exact commit. Queried again for `597bd111` (F-24 identity-binding tests): run `34368029271`, `completed/success`, `headSha` matching that exact commit. |
| Deployment | 🔲 — API to Railway, web to Vercel (D14). Neither connected. **Public deployment is additionally blocked by F-15** (auth-before-rate-limit + unreviewed proxy trust) **and F-17** (production `npm start` runs `tsx`, a devDependency). Registration being live locally does not soften either: `/auth/register` is the product's first public mutating route and sits behind the same flat 300/min/IP limit, so it must not be described as production-ready. |
| Auth contract (AUTH.md) | ✅ frozen 2026-08-25 |
| Tenant repository boundary (F-01) | ✅ `TenantContext` + `shiftRepository`, joined at Start Shift by `startShiftRepository` — a second, deliberately narrow repository over the same boundary (its selectors are built from `TenantContext` only; it exists because `buildApp` takes a structural database rather than a `PrismaClient`, and because Company/User reads do not belong to a Shift repository). 11 Company A/B tests. Since `c742b03` a `TenantContext` is frozen on construction, so tenant authority cannot be repointed, extended or trimmed by anything holding it — 4 tests in `api/src/lib/tenantContext.test.ts`, written RED. Forging one with a double cast remains possible and is documented in the class itself; see **F-22** and D16. |
| Outbox enqueue uniqueness (F-09) | ✅ `SubmitJobStatus` enum + one row per shift, migration 2 — this is **storage/enqueue uniqueness only**. Transaction atomicity of transition-plus-enqueue, worker-claim idempotency and exactly-once external email delivery are **not** proven; see **F-16**. Do not describe this row as "submission idempotency". |
| Rule-engine fixture tests (F-08) | ✅ `scripts/rules/engine.test.ts` — every rule proven wired |
| Email fail-closed in production (F-07) | ✅ SENDGRID_API_KEY + MAIL_FROM required unless explicitly dev/test |
| Default-deny route authentication (F-10) | ✅ closed — a root `onRequest` hook in `app.ts` rejects every route unless explicitly marked (since D21, `authPosture`; the marker was `public` before). A secondary static guardrail (`route-declares-auth`) enforces explicit route posture in `check-rules`; the root runtime hook remains the security boundary. See "Known limitations" below for the guardrail's known parser gap. |
| Same-company driver isolation (F-11) | ✅ closed — driver-facing repository methods are scoped by `companyId` AND owning membership, not company alone; same-company driver-vs-driver isolation is proven by the DB integration suite (counted in "Database tenant-integrity proof" above). |
| Protected-request authentication (P1.2a) | ✅ — `requireAuth` verifies a Bearer JWT (HS256 pinned; issuer `logisticbay-timesheets`; audience `timesheets-api`; `iat`/`exp`/`iss`/`aud` required by the verifier, `sub`/`companyId`/`membershipId`/`sessionId` by the claims schema), enforces the frozen declared lifetime `0 < exp - iat <= 900s` **and, since F-19 closed, `iat <= now + 60s`** (shared with the identity pipeline through one helper, so the two kinds cannot drift apart on timing), then requires a persisted Session (present, not revoked, not past its absolute expiry, `userId === sub`) and a persisted CompanyMembership (present, `userId === sub`, `companyId === token.companyId`). The token's `companyId` is cross-checked against the row and never authority on its own — the AuthContext company comes from the persisted membership, and `role` is read fresh from that row on every request. Produces exactly `{ userId, companyId, membershipId, sessionId, role, membershipStatus }`. Every failure is the identical `401 { "error": "Not authenticated", "code": "UNAUTHENTICATED" }`, so the boundary is not an oracle for which check failed. Database access is the narrow `AuthStore` (two primary-key reads, records rebuilt field by field) — `requireAuth` never receives a PrismaClient or `AppDatabase`. Proven by 18 pipeline tests (`src/lib/auth.test.ts`, each negative paired with a positive control) and 2 tests against real persisted rows (`src/tests/db/authProtectedRequest.test.ts`). Two of the eighteen are the identity bindings `session.userId === sub` and `membership.userId === sub`, added in `597bd111` (**F-24 closed**): each was proven load-bearing by deleting only its own production check, which failed that case alone with `200 !== 401` and left the other green. That is evidence for those two bindings, not for the whole boundary — the deferred negative matrix (wrong-*value* `iss`/`aud`, `alg:none`, a missing membership row) is still outstanding. |
| **Registration + identity authentication (Increment 1)** | ✅ — `POST /auth/register` (public) and `GET /auth/me` (identity posture). Registration accepts EXACTLY `firstName`, `lastName`, `email`, `password`; the DTO is `.strict()`, so `companyId`, `membershipId`, `userId`, `id`, `role`, `passwordHash` or any unknown key is **refused**, not ignored. Email is stored trim+lowercase and the DATABASE (citext) refuses a case variant. Password: min 10 characters, max **72 UTF-8 bytes** (measured in bytes, because bcrypt truncates there and 72 bytes is as few as 18 accented characters), no composition rules, bcryptjs cost 12 (measured ~230 ms hash / ~231 ms verify on Node 22.13). A success creates a `User` and ONE `Session` **atomically** — 90-day absolute expiry, `revokedAt`/previous-token columns null, `refreshTokenHash` = SHA-256 of the returned secret — and returns `{ user, identityToken, refreshToken, memberships: [] }`. **Zero memberships is a success**, and no Company, CompanyMembership or Shift is created. A duplicate email (any casing, including concurrently) is `409 EMAIL_IN_USE` disclosing nothing else — a knowingly accepted enumeration trade-off (D24). Proven by 20 route-contract tests, 14 database tests and a live end-to-end run against a real server |
| Identity token + the two-token separation (D21) | ✅ — `{ sub, sessionId, iat, exp, iss, aud: "timesheets-identity" }`, HS256, **TTL 15 minutes**, no `companyId`, `membershipId` or `role` and no optional slot for one. `requireSession` verifies signature/algorithm/issuer/**identity audience**/required claims, the timing rules, then the Session (present, unrevoked, unexpired, `userId === sub`) and **stops** — no membership read, no `AuthContext`, no `TenantContext`, and no function converts an `IdentityContext` into one. The separation is symmetric and enforced by the verifier, not by a claim someone must remember to read: an identity token at a tenant route is `401` (proven with a tenant-token positive control, and again with forged `companyId`/`membershipId`/`role` bolted on), and a tenant token at an identity route is `401`. **No token reaches tenant data without naming and validating a real membership.** The tenant token is unchanged and its `companyId`/`membershipId` remain mandatory |
| Three route postures (D21) | ✅ — `config: { authPosture: "public" \| "identity" \| "tenant" }`, one branch in the existing root `onRequest` hook. **Tenant is the default** and only an EXACT `"public"`/`"identity"` relaxes anything: a test injects `"Public"`, `"PUBLIC"`, `"publik"`, `"identity "`, `"none"`, `""` and `"true"` through a cast — because the compiler would catch these at a real call site, so the runtime must not depend on it — and every one is `401`. F-10's polarity extended, not replaced; `route-declares-auth` and its fixtures now understand the third posture, and remain a guardrail, not the boundary (D16) |
| **Login** | ✅ — `POST /auth/login` (public), strict two-field DTO (`companyId`/`membershipId`/`role`/`userId`/`sessionId`/`id`/`passwordHash`/`identityToken`/`refreshToken`/`memberships` all REFUSED, not ignored). Email canonicalised as registration does; password **not** trimmed and **not** subject to D23's 10-character minimum (a policy governs NEW credentials — an account created under an older policy must still get in), but capped at 72 UTF-8 bytes because bcrypt reads no further. Unknown email verifies against a FIXED cost-12 dummy hash so it costs the same ~230 ms a wrong password costs; a malformed/unsupported stored hash fails closed to the same 401 rather than escaping as a 500. Every failure is the canonical `401 UNAUTHENTICATED`, byte-identical. A NEW Session per login; no other session touched. 31 route/DB tests |
| **Refresh rotation + the 60-second grace (F-21 CLOSED)** | ✅ — `POST /auth/refresh` (public posture; the CREDENTIAL authenticates it). Two unique lookups with CURRENT precedence, never an `OR` across both digest columns — `RefreshDatabase` declares only `findUnique`/`updateMany`, so the ambiguous query does not typecheck. Rotation and recovery are conditional `updateMany` writes whose `where` restates the expected state; the affected-row count is the proof. `Session.expiresAt` is never in `data`. Recovery from a previous credential leaves the previous digest and its deadline UNTOUCHED, so retries work and the window cannot be stretched. Reuse outside grace revokes the session. **Reuse detection is one generation deep** — the schema holds a single previous digest, so an older credential is answered as unknown, not as reuse, and that is stated rather than papered over. **Concurrency (clarified 2026-09-12, AUTH.md):** only one request may rotate a credential as CURRENT, but a concurrent request may legitimately succeed through grace recovery — two simultaneous `200`s are correct. What may never happen is two usable lineages, a forked Session or a moved `expiresAt`. **22 DB tests** including a crafted cross-column collision and four concurrency cases. Two of those are deterministic repository-level proofs added at the audit closeout, because the atomic predicates they guard are unreachable through the HTTP surface and a race cannot force the interleaving that would expose their absence: `C4` proves `rotateCurrent` applies only to the digest the caller presented, and `R15` proves the grace deadline is enforced by the database `where` clause and not only by the service's clock check (both F-26). Each was proven load-bearing by deleting only its own predicate, which failed that case alone. **No schema change: still 8 migrations** |
| **Logout + revocation** | ✅ — `POST /auth/logout` (identity posture, no body — a logout that could name its own session could log out another device). Conditioned on `revokedAt IS NULL`, so the first revocation timestamp is kept. Proven to kill all THREE credentials at once (identity, tenant, refresh) through their three separate pipelines, and to kill nothing belonging to another session. On the device the local clear happens even with no network, and the client never claims the server revocation succeeded when it did not. 7 DB tests |
| **0 / 1 / 2+ membership authentication + company switch** | ✅ — zero active memberships → identity only, `memberships: []`, no tenant token. Exactly one ACTIVE membership → auto-selected, tenant token minted from the ROW (D12/D13). Two or more → the list and NO tenant token until `POST /auth/switch-company` (identity posture) revalidates the requested `membershipId` against the authenticated user AND `active: true` in one query, then mints from the row it loaded. Same Session; no new session; the refresh lineage is untouched. Another user's membership, an inactive one and a nonexistent one are refused **byte-identically** (`403 FORBIDDEN`). A switch away from an open shift under a DIFFERENT membership is the opaque `409 SHIFT_ALREADY_OPEN`; selecting the open shift's own company is allowed. Memberships are seeded directly in tests — **no onboarding exists**, so no real driver can reach the 1/2+ branches yet (F-18 still blocks that). 15 DB tests |
| Cross-company open-shift guard | ✅ — the ONE sanctioned cross-tenant read (`hasOpenShiftOutsideMembership`). Identity comes from the authenticated session, never a request; the delegate is `count`, so no shift row can leave; the result is collapsed to a boolean, so not even the count escapes. A test pins that the refused 409 discloses no shift id, driver name, company id, company name or membership id, and that a stranger cannot aim it at another driver |
| **P1.2b — Authorized Tenant Context** | ✅ — F-14 closed in `2c85f4f`. `authorizeTenant(auth: AuthContext): TenantContext` (`api/src/lib/authorization.ts`) is the one production place authenticated identity becomes tenant authority, and the only production caller of `TenantContext.trust()`. It takes the trusted `AuthContext` and **nothing else** — no `companyId`, `membershipId`, `userId`, `role`, request, body, query or options parameter — so client-supplied identity has no channel to arrive through; and it performs **no database read**, because `requireAuth` already validated the identity against persistence. Active membership → a `TenantContext` carrying `companyId`, `userId` **and** `membershipId` (all three; `membershipId` is what `shiftRepository` scopes `findById`/`update`/`delete` on, per D15). Anything not exactly `"active"` → generic `403 FORBIDDEN` (D17); the comparison is `!== "active"`, so a future third membership state would fail closed. Proven by 5 tests in `api/src/lib/authorization.test.ts`, written RED and reviewed before implementation; `npm run check` exit 0 at `2c85f4f` (110/110 unit, 45/45 DB, 4 migrations). The static rules were **not** changed: `tenant-context-trust-sites` already permitted `lib/auth*`, so the bridge needed no rule change. That exemption is an unanchored path substring and its coverage is narrower than earlier wording here claimed — see **F-23**. Independently audited 2026-08-31 against `60effc9`: the P1.2b invariant held under every attack constructed against it (no inactive bypass, no role bypass, no alternate construction path, no client channel through body, query, path params or headers); the audit opened **F-22**, **F-23** and **F-24**, none of which invalidates this row (**F-24** has since been closed in `597bd111`). |
| Inactive-membership authorization — **ordinary/default rule** | ✅ — the default-deny half of AUTH.md's "Deactivated membership" section is implemented: an inactive membership still authenticates and is reported as `inactive` (P1.2a, unchanged), and is then refused ordinary tenant authority with `403 { "error": "Not allowed", "code": "FORBIDDEN" }`. Generic on purpose — the response never discloses that a deactivated membership caused the denial (D17). Role is not a bypass: an inactive **admin** is denied identically. |
| Inactive-membership authorization — **the narrow exception** | 🔲 — AUTH.md permits a deactivated membership to read, update and submit an **already-open** shift, and nothing else. **None of that exists.** There is no finalise capability, no discard capability, no `allowInactive`, no bypass flag, no capability token, no permission enum and no policy engine. Its concrete API is an open design question, not a settled one; the only frozen fact is that any such operation must be explicit and narrow. It will be designed with the business feature that needs it. |
| **Start Shift backend foundation** | ✅ — the first protected business route. `POST /shifts/start` and `GET /shifts/current` (`api/src/routes/shifts.ts`), behind the existing pipeline: default-deny hook → `requireAuth` → `authorizeTenant` → `TenantContext` → `api/src/repositories/startShiftRepository.ts`. An active `driver` **or** `admin` membership starts ONE shift for its own trusted identity: `status = active` (D19) with **zero** `ShiftSegment` rows — the driver who has booked on but has no truck yet, represented with no placeholder asset of any kind. `driverName` is snapshotted from `User.name` and `shiftDate` derived once from the declared `startedAt` in `Company.timezone` (D18) — both server-side; the DTO is `.strict()`, so a client sending `companyId`, `userId`, `membershipId`, `shiftDate`, `timezone`, `driverName` or `status` is refused, not ignored. Offline identity is a client-generated `clientEventId`, unique per `(membershipId, clientEventId)` (D19): an exact replay returns the existing shift with `200`, the same event with a different `startedAt` is `409 CLIENT_EVENT_MISMATCH`, and a genuinely new start while any shift is open is an opaque `409 SHIFT_ALREADY_OPEN` — identical whether that open shift is in this company or another, so company B never learns the driver is on shift for company A. `startedAt` is driver-declared data: any valid offset-aware instant is accepted and stored verbatim, past or future, never clamped (D20). Proven by **21 database tests** (`api/src/tests/db/startShift.test.ts`) plus 9 route-contract tests (`api/src/routes/shifts.test.ts`), including a 4-way concurrency race producing exactly one row, a non-UK timezone boundary where the UTC and company-local dates differ, and same-company driver-vs-driver isolation on the recovery read. Four ephemeral mutations each failed exactly the cases they should and were reverted before commit: deleting the pre-read left all tests green (the DATABASE carries retry safety, not the read), unmapping `P2002` failed the four conflict cases, deleting the mismatch check failed only that case, and substituting UTC for the company zone failed only the timezone case. **What this is NOT:** no mobile UI, no vehicle/trailer/check branch, no Finish Shift, and no way for a driver to obtain a token — so no real driver can reach it yet |
| First protected business route — remaining schema facts | 🔲 — two facts the row above deliberately did not build: (1) `shiftDate` immutability is still design intent — no database constraint prevents an update, and nothing updates it today because Start Shift creates no update path; (2) no Night Out field exists on `Shift`. Also unchanged: no company can choose its timezone (settings/onboarding unbuilt), so every company sits on the `Europe/London` default |
| Company timezone authority (D18) | ✅ — implemented in `4888d63`. `Company.timezone` is `String @default("Europe/London")`, NOT NULL in PostgreSQL (`TEXT NOT NULL DEFAULT 'Europe/London'`, migration 5), so every Company row carries the authority D18 derives `Shift.shiftDate` from. An IANA **identifier**, never a numeric offset. `Europe/London` is the **V1 default, not a statement that the product is UK-only** — `Europe/Vilnius`, `America/New_York`, `Asia/Dubai` and `Australia/Sydney` round-trip verbatim; 5 tests in `src/tests/db/companyTimezone.test.ts`, written RED against the missing column, also prove NOT NULL (SQLSTATE 23502), that the stored column default is itself a real IANA identifier, and that no competing timezone column exists on any other model. The conversion foundation is `api/src/lib/timezone.ts` — `isIanaTimeZone` (the runtime's own ICU tz database is the authority, plus explicit rejection of the offset forms `Intl` would otherwise accept) and `localCalendarDate(instant, timeZone)` (pure; returns midnight UTC, the `@db.Date` storage form). 11 tests in `src/lib/timezone.test.ts` cover the required boundary — a `2026-07-02 00:30 Europe/London` start files under **2026-07-02**, not the UTC date `2026-07-01` — plus one instant filing under different dates in four zones (including a negative offset and a 45-minute one), a summer/winter pair no fixed offset survives, both DST transitions, and a 22:00 → 06:00 night shift filed under its **start** date. The schema's `shiftDate` comment now states D18 rather than "(O8, provisional)". **What this is not:** nothing WRITES this column in production — there is no company settings/onboarding path to choose a timezone, so every company sits on the `Europe/London` default and worldwide *usability* does not follow from the data model supporting it. It is now READ in production: Start Shift derives every `shiftDate` from it through `localCalendarDate`, which is the helper's first production caller. `npm run check` exit 0 at `4888d63` (125/125 unit, 50/50 DB, 5 migrations); GitHub Actions run `33436174195` `completed/success` for that exact SHA. |
| Session persistence foundation | ✅ P1.1 — a global `Session` owned by `User`, carrying NO company authority (no `companyId`, no `membershipId`); absolute `expiresAt` (90-day device lifetime, not extended by rotation); explicit `revokedAt`; current and optional previous refresh-token hash; previous-token grace deadline. Enforced by the database: unique current hash, unique non-null previous hash, CHECK `Session_previous_token_paired` (previous hash and grace deadline both NULL or both set), CHECK `Session_previous_token_distinct` (previous ≠ current), and `onDelete: Cascade` from User. Proven by 10 tests in `src/tests/db/sessionPersistence.test.ts`, written RED before the schema existed. Since P1.2a the pipeline reads existence, `revokedAt`, `expiresAt` and `userId` on every protected request; the refresh-token columns and the grace deadline remain unread — no rotation logic exists. |
| Refresh-token rotation + grace-window behaviour | ✅ — see the refresh row above. F-21 closed 2026-09-11 |
| Multi-company driver memberships | 🔶 — AUTHENTICATION for 0/1/2+ memberships is built and proven (see above). What is missing is the way to CREATE a membership: no onboarding, no invitation, no join-code flow (F-18), and no company UI. So the 1/2+ branches are reachable only by seeding rows |
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
  `authPosture:` key elsewhere in the file — a false negative where a genuinely
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
  already confines token verification — today `src/lib/auth.ts` and
  `src/lib/tokens.ts`, both of which now exist, an
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
  wrong matters most. Every protected route must therefore narrow it. The first
  consumer landed with Start Shift and does so through one small local helper
  (`authenticated()` in `api/src/routes/shifts.ts`) that fails closed as an
  internal fault rather than as a 401 — a protected route reached without a
  context is a wiring defect, not a client error. Accepted as-is; revisit if a
  second narrowing style appears.

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

- **RESOLVED at Start Shift.** The P1.2b audit (2026-08-31) recorded that three
  of the four tenant rules scanned zero production files, because `src/routes/`
  and `src/services/` did not exist. They do now, and the rules were shown to
  bite on them: with `request.body.companyId` temporarily inserted into
  `api/src/routes/shifts.ts`, `check-rules` reported `[no-client-tenant]` at
  that line; the line was reverted and the file verified byte-identical.

- **Company-level state is never consulted on the authority path (P1.2b audit,
  2026-08-31, Observation).** `Company.status` (`trial | active | past_due |
  cancelled`) is read by nothing, and there is no global `User.active`, so an
  active member of a cancelled company retains full tenant authority.
  Known-not-built — "Subscription enforcement 🔲" below owns it. Recorded here
  only because `authorizeTenant` is the single chokepoint such enforcement will
  have to land in, rather than in individual routes.

- **Stale comments and config outside documentation scope (audit 2026-08-31).**
  Six reconciliation items found by the audit that live in **code, tests or
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

---

## Infrastructure

| Area | State |
|---|---|
| Repo initialised (git) | ✅ `main` — active repository; Git and the live remote own the current baseline (AGENT_WORKFLOW.md §2) |
| API skeleton boots (`/health`) | ✅ verified on the Mac |
| First Prisma schema | ✅ migration-managed (8 migrations; see "Migrations" row under Backend) — `db:push` bootstrapping was retired |
| Local Postgres (docker-compose, port 5544) | ✅ running |
| Dependencies installed | ✅ on the Mac; Node 22.13.0 (via `nvm use`, matching `.nvmrc`), npm 10.9.2. **Three workspaces now**: root, `api/`, `mobile/` — each needs its own `npm install`/`npm ci`, and CI installs all three |
| `timesheets.logisticbay.com` DNS | 🔲 |
| `timesheets-api.logisticbay.com` DNS | 🔲 |
| Database provisioned | 🔲 |
| Deployment pipeline | 🔲 |
| Marketing site menu linking both products | 🔲 |
