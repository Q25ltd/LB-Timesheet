# LogisticBay Timesheets — Devlog

> Newest entry first. What was built, what was decided, what was deferred.

---

## 2026-08-31 — P1.2b: Authorized Tenant Context (F-14 closed)

Implementation `2c85f4f89080cdd8c4bf74d3c72ba51223a641c8`. RED was written and
reviewed before any production code existed; GREEN followed only after the owner
accepted it.

**The gap.** `requireAuth` answered "is there a valid identity". Nothing answered
"may this identity do this". `AuthContext` and `TenantContext` both existed, but
`TenantContext.trust()` had no production caller and `membershipStatus` was
produced on every request and read by nobody — so a future route could have
mistaken authentication for authorization.

**Built.** `authorizeTenant(auth: AuthContext): TenantContext` in
`api/src/lib/authorization.ts` — now the one production place authenticated
identity becomes tenant authority, and the only production caller of
`TenantContext.trust()`. It takes the trusted `AuthContext` and nothing else: no
`companyId`, `membershipId`, `userId`, `role`, request, body, query or options
parameter, so client-supplied identity has no channel to arrive through and no
rejection code is needed. It performs no database read — `requireAuth` already
validated the identity against persistence, and a second read would be a second
source of truth.

An active membership gets a `TenantContext` preserving **`companyId`, `userId`
and `membershipId`**. All three matter: `shiftRepository` scopes
`findById`/`update`/`delete` on `membershipId`, so reducing the context to
company-plus-user would have widened each of them from "this driver's shift" to
"anyone's shift in this company" (D15).

Anything not exactly `"active"` is denied with the generic
`403 { "error": "Not allowed", "code": "FORBIDDEN" }` — frozen this session as
**D17**. The response never discloses that a deactivated membership caused it;
role is not a bypass, and an inactive admin is refused identically. The
comparison is `!== "active"` rather than `=== "inactive"`, so a future third
membership state fails closed.

**Deliberately not built.** No generic inactive bypass exists — no
`allowInactive`, no bypass flag, no capability token, no permission enum, no
policy engine. AUTH.md's limited operations for a deactivated membership (read,
update and submit an already-open shift) are **not implemented**; their concrete
API remains an open design question to be settled with the business feature that
needs them. No business route, no login, no token minting, no refresh, no logout,
no company switching. `requireAuth` is unchanged — an inactive membership still
authenticates.

**Touched.** `api/src/lib/authorization.ts` (new), its test (new), and one word
in `api/src/lib/auth.ts`: `AuthContext` gained `export`, with no change to the
six-field P1.2a contract. The static rules were not changed —
`tenant-context-trust-sites` already permitted `lib/auth*`, and still bans
`trust()` in routes, services and repositories.

**Verified.** Focused P1.2b tests 5/5. Authoritative `npm run check` exit 0:
110/110 unit tests, 45/45 DB/integration tests, four migrations onto a clean
database. Pushed to `main` and confirmed live on GitHub by SHA.

**Left open.** The first protected business route is no longer blocked by F-14;
it is still blocked by **O8**. F-15 and F-17 still block public deployment. The
stale `requireAuth` comment at `api/src/lib/auth.ts:115` was recorded in
STATUS.md's cleanup backlog rather than edited — this was a documentation-only
reconciliation.

---

## 2026-08-31 — Independent backend foundation audit

A fresh independent architecture/security audit ran read-only against
`0591241c539b0469fa0223787a80d16eaa8e4882`. Nothing was built or fixed; the
repository stayed clean and frozen throughout. This entry records the outcome —
the findings themselves live in FINDINGS.md, and current state lives in
STATUS.md.

**Result: 0 Critical, 0 High, 5 Medium, 4 Low, 4 Observation.** The authoritative
gate was green at the audited commit: 105 unit tests, 45 DB/integration tests,
four migrations onto a fresh database.

**Not demonstrated** — no unauthenticated authentication bypass; no
cross-company escape through Shift, ShiftSegment or ShiftSubmitJob; no
same-company driver-to-driver escape through `shiftRepository`. P1.2a was not
invalidated and remains ✅.

**What the audit established is what comes next.** The gap it found is not in
authentication but immediately above it: nothing converts authenticated
`request.auth` into a repository `TenantContext`, and no policy consumes
`membershipStatus`, so a future route could mistake authentication for
authorization. That is F-14, and it is the next boundary — **P1.2b, Authorized
Tenant Context**. The first protected business route is blocked on it, and
separately on **O8**, which must be decided before `shiftDate` can be persisted
correctly. Public deployment is blocked on at least F-15 (authentication runs
ahead of the limiter, and proxy trust is unreviewed) and F-17 (production
`npm start` invokes `tsx`, a devDependency). Development itself is not blocked:
P1.2b and login groundwork may both proceed.

**Governance.** Eight canonical IDs were assigned in one pass — **F-14…F-21** —
after re-verifying every `F-XX` in the working tree and across `git log --all`.
`F-12` remains reserved and was deliberately not used; reserved is not the same
as next-available. Three audit items were recorded **without** an ID, in
FINDINGS.md's "Known sub-issues" section and STATUS.md's cleanup backlog, because
they are accepted non-blocking limitations rather than trackable work:
destructive `db-check` naming, `AuthStore` Session over-fetch, and the
confirmation that static rules remain guardrails (D16 working as designed, not a
defect). The npm advisory chain through Prisma was already recorded on
2026-08-25 and was not duplicated. O8 belongs to DECISIONS.md and was
cross-referenced, not restated. The audit's report-local `AUDIT-2026-*`
identifiers are not canonical and appear nowhere in this repository.

**One wording correction with teeth.** F-09's one-row-per-shift constraint had
been described — in STATUS, the schema and a test — as "submission idempotency".
It is enqueue uniqueness only. Transaction atomicity, worker-claim idempotency
and exactly-once email delivery are separate guarantees, none of them proven
(F-16). The STATUS wording is fixed here; the schema and test comments are code
scope and are listed for a later authorized pass.

**Owner decisions still open**, recorded as open rather than resolved: O8's
filing-date/timezone rule, the `iat` clock-skew allowance, the rate-limit and
`trustProxy` values, invitation expiry and format, the `notes` audience (F-20 —
removal remains valid), and the refresh-token lookup design (F-21).

---

## 2026-08-31 — P1.2a: protected-request authentication

`requireAuth` is no longer a stub. Shipped as
`564169191dc39e7c09e556cf1bc6158f18d0ac32`. AUTH.md's "Every protected request"
pipeline, and nothing beyond it — this boundary answers *is there a valid
identity*, never *may this identity do this*.

**The pipeline.** A Bearer token is verified with HS256 pinned, issuer
`logisticbay-timesheets` and audience `timesheets-api` — iss/aud make a
LogisticBay TMS token structurally unusable here even if a secret ever leaked
between the products (D1). All eight claims are required: `iat`/`exp`/`iss`/
`aud` by the verifier, `sub`/`companyId`/`membershipId`/`sessionId` by a bounded
Zod schema, so each claim is decided in exactly one place. `iat`/`exp` are
parsed as NumericDate integers. Then the persisted Session must exist, not be
revoked, not be past its absolute expiry, and satisfy `session.userId ===
token.sub`; then the persisted CompanyMembership must exist and satisfy
`membership.userId === token.sub` and `membership.companyId ===
token.companyId`.

**The token's `companyId` is never standalone authority.** It is a claim to
validate against the row; the AuthContext's company comes from the persisted
membership, and `role` is read fresh from that row on every request, so a
changed or revoked role takes effect immediately instead of outliving its
revocation. `membershipStatus` derives from `CompanyMembership.active` via an
explicit `=== true`, so anything that is not exactly true resolves to the more
restricted `inactive`.

**Exactly six fields** — `{ userId, companyId, membershipId, sessionId, role,
membershipStatus }` — and every failure path returns the identical
`401 { "error": "Not authenticated", "code": "UNAUTHENTICATED" }`, constructed
inside the boundary so a verifier error can neither reach the global handler as
a 500 nor become an oracle for which check failed (F-05). An inactive membership
**authenticates** and is reported as inactive; the 403 rules that act on that
are not this boundary.

**A narrow `AuthStore`, not a database handle.** Two reads by primary key
returning records rebuilt field by field. `requireAuth` never receives a
PrismaClient or `AppDatabase`, so it cannot reach a tenant model, run a raw
query, or write anything — the restriction is structural, not remembered. This
is an adapter for one caller; the tenant-safe repository boundary is a different
mechanism for a different problem and is untouched.

**The hardening sequence, recorded because the order matters.** Adversarial
review of the unfinished work found that a token *omitting* registered claims
was accepted: `allowedIss`/`allowedAud` validate a value when present but do not
themselves require presence, and expiry is only checked when `exp` exists — so a
token with no `exp`/`iss`/`aud` verified, i.e. an unexpiring, cross-product
token. `requiredClaims` was added. A second probe then showed that ordinary
expiration validation still did not enforce AUTH.md's frozen 15-minute TTL: no
verifier option relates `exp` to `iat`, and `maxAge` measures age against the
server clock, which would accept a 24-hour token for its first 15 minutes. The
explicit invariant `0 < exp - iat <= 900` was implemented and adversarially
verified. Both were found and fixed **before** the boundary was accepted; they
are development history, not open defects, and neither received a finding ID.

**One authorized static-rule correction.** `no-company-id-in-dto` fired on the
verified-token claims schema. It now skips exactly the modules where
`jwt-centralised` already confines token verification — the same boundary named
once and shared by both rules, so the two cannot drift apart. Scoping it to
`routes/` + `services/` was rejected: nothing structurally confines a request
DTO to those directories, so that would have traded a false positive for a
false-negative path. Good/bad fixtures prove both sides. No `rules-ignore`, no
blanket `src/lib` exemption. It remains a static guardrail, not a security proof
(D16), and its residual limitation is recorded in STATUS.md.

**Verified.** Authoritative `npm run check` exit 0: 105/105 unit tests, 45/45
DB/integration tests, four migrations deployed to a fresh database, `db-check:
OK`. Within those: 16/16 P1.2a pipeline tests (every negative case paired with a
positive control, so a test cannot pass because the setup was broken), 2/2
against real persisted rows, 5/5 default-deny (F-10), 32/32 rule engine/pattern
tests. `git diff --check` clean, tree clean at commit.

**Explicitly NOT built.** Token minting, login, refresh-token lookup and
rotation, logout, company selection, company switching, inactive-membership
authorization, the AuthContext → TenantContext bridge, any route that reads
`request.auth`, and all mobile/offline authentication. Nothing in this product
issues a token today.

---

## 2026-08-31 — P1.1: Session persistence foundation (no authentication)

The first Phase 1 boundary, deliberately scoped to persistence alone. Shipped
as `86cd4e28880a629bfcd3c2f15c3f0de91ee27e8b`.

**A global `Session`, owned by `User`.** No company authority is stored on it —
no `companyId`, no `membershipId` — because AUTH.md says a session survives
company switching, so tenant scope belongs in the access token and the
membership row. A second authority there could contradict the token. check-rules
had already allowlisted `Session` in `GLOBAL_MODELS` with a note not to "fix" it
by adding `companyId`; that note is now load-bearing.

Columns: absolute `expiresAt` (90-day device lifetime; rotation will not extend
it — no sliding window, no separate cap), explicit `revokedAt`, current
`refreshTokenHash`, optional `previousRefreshTokenHash`, and
`previousRefreshTokenGraceUntil`. The grace window is stored as a DEADLINE
rather than a rotation timestamp plus a constant, so changing the 60-second
period later cannot retroactively revive a token that was already dead.

**Migration `20260831090000_session_persistence_foundation`.** Table, indexes
and FK generated by `prisma migrate diff` (baseline schema → current), with two
CHECK constraints appended by hand because Prisma cannot express them:
`Session_previous_token_paired` (previous hash and grace deadline are one fact —
both NULL or both set) and `Session_previous_token_distinct` (a rotation that
wrote the same token into both slots would make the grace window meaningless).
Earlier migrations untouched; `invariants.sql` untouched.

**RED existed before the schema did.** `src/tests/db/sessionPersistence.test.ts`
was written and run first: 10 failures, all from one `before` hook asserting the
`Session` table exists, plus 18 typecheck errors from a client with no `session`
delegate. Only then were the model and migration written.

**One test-only correction at GREEN.** The CHECK-violation assertions expected
the SQLSTATE at `meta.code`; under the PrismaPg driver adapter it actually
arrives at `meta.driverAdapterError.cause.code`. Probed the real error object
before touching anything — the database had genuinely rejected all three rows
naming the intended constraint — then adapted the extraction path. Still asserts
the Postgres error class `23514` (check_violation), never message text, and a
positive-control insert proves the same raw statement succeeds when well-formed.

**Verified.** Targeted GREEN 43/43 DB tests, then the authoritative root
`npm run check` GREEN end to end on Node 22.13.0: generate, tsc, eslint,
check-rules, prisma validate, knip, **89/89 unit tests**, **43/43 DB tests**
(33 pre-existing + 10 new), with **4 migrations** deployed onto a clean
database by `migrate deploy`.

**Explicitly NOT built, and not started.** JWT verification, `requireAuth`
(still the stub that rejects every protected request), login, refresh rotation,
logout, company switching, `AuthContext`, typed `request.auth`. Nothing in the
repo reads a Session column yet. A Session table is not authentication.

Design decisions taken before this landed and still governing the next step:
session lifetime is ABSOLUTE; `Session.userId === token.sub` will be an extra
401 condition in `requireAuth`; `Company.status` stays out of `requireAuth`;
`membershipStatus` derives from `CompanyMembership.active`; refresh-token
representation stays in the Session row per frozen AUTH.md. Session cleanup and
retention are untouched (still gated by D9/O1).

---

## 2026-08-25 — Pushed to GitHub; CI run #1 failed and was rebuilt

Repo is live at `github.com/Q25ltd/LB-Timesheet`, baseline `13456ac` plus
`74ab318` (eslint, prisma validate, no-prisma-in-routes, the Phase 0 audit).

**CI run #1 failed at `npx knip`** with "Unlisted binaries: eslint, knip". Cause:
the workflow ran `npm ci --prefix api` only, and both eslint and knip are **root**
devDependencies — so their binaries did not exist in CI. It passes locally purely
because the root `node_modules` is present there.

I had predicted this would pass hollowly rather than fail. It failed, which is
the better outcome; the prediction was wrong.

**Workflow rebuilt around a single principle: CI runs exactly what a developer
runs.** It now installs both workspaces, pushes the schema, then calls
`npm run check` as one step. Adding a gate locally now adds it to CI
automatically — the two cannot drift, and nobody has to remember to update a
list of steps. The previous version enumerated steps individually and had
silently omitted eslint and prisma validate entirely.

**Also fixed:** `api/package.json` declared a `lint` script for a binary it does
not own (eslint is a root devDependency). Removed — the root `eslint .` already
covers every workspace, and knip was right to flag it.

**`.nvmrc` 22.12.0 → 22.13.0**, clearing the `EBADENGINE` warning from
`eslint-visitor-keys` (wants `^22.13.0`). Still satisfies Prisma 7's floor.
Requires `nvm install 22.13.0` locally.

**D14 recorded** after Vercel emailed offering to import `api/` as a Fastify
project: the API is not serverless and goes to Railway. The outbox worker needs a
long-running process; a serverless API would leave submitted timesheets
undelivered — the exact failure the outbox was built to prevent.

---

## 2026-08-25 — Auth contract designed and frozen (no code yet)

Deliberately designed and written down **before** implementation, on the grounds
that every protected route inherits whatever auth gets built — so a mistake here
is not a refactor, it is a rewrite of every route.

Full contract in the new **AUTH.md**; decision summary as D13.

**A correction worth recording.** The claim that putting `companyId` in the token
makes scoping "automatic" was wrong, and the user pushed back on it. It does not.
It removes the client from the decision and gives the server a claim to validate
against — prevention still requires middleware resolving a trusted AuthContext,
every query using it, and something stopping a developer reaching past it.

That last part is now mechanical: `check-rules` gained a **`no-client-tenant`**
check that fails the build if anything under `src/routes/` reads `companyId`,
`membershipId` or `userId` from a request body, query or params. Verified against
a probe route before shipping — it fires, and it stops firing when the probe is
removed.

**Interaction nobody had considered: offline vs token lifetime.** 15-minute access
tokens are fine for a driver in a dead zone only because work queues locally and
syncs later — but the *refresh* token has to be generous (90 days) or a driver
returning from a fortnight off gets a forced re-login at the worst moment.
Rotation uses a 60-second grace window for the same reason: strict rotation logs
a driver out if signal drops mid-exchange.

**25 contract tests are specified in AUTH.md and are to be written before the
implementation**, not after.

---

## 2026-08-30 — F-08/F-09/F-07/F-13: checker proven, outbox constrained, docs truthful

**F-08.** check-rules split into `scripts/rules/engine.ts` (pure, parameterised
root) and a thin CLI. New fixture trees under `scripts/rules/__fixtures__/`:
`bad/` makes every one of the 16 rules fire at exact asserted lines; `good/` is
realistic legitimate code (including `reply.send(body)`) asserted to produce
ZERO violations. Deleting or un-wiring any rule now turns `engine.test.ts` red —
the regression three reviews proved was undetectable. Two predicate fixes the
fixtures forced: `req.body?.companyId` (optional chaining) is now caught, and
the bare `body`/`params` argument match was dropped from the route-boundary rule
because it flagged `reply.send(body)` — a guard that fires on correct code gets
disabled. Fixtures are exempted from eslint/tsc/knip (deliberately broken code).

**F-09.** `ShiftSubmitJob.status` → `SubmitJobStatus` enum; `@@unique([shiftId])`
= ONE outbox row per shift, making offline submit retries idempotent at the
database — a duplicate insert is a P2002, a failed delivery is retried by
UPDATING the row. Migration 2 written by hand (this environment cannot run
`migrate diff`): enum create + column cast (`USING status::"SubmitJobStatus"` —
an out-of-vocabulary value fails the cast loudly, which is correct) + unique
index. Proven the same way as migration 1: `npm run check`'s db stage deploys
both onto a clean database. +2 integrity tests.

**F-07.** Production (and anything not explicitly dev/test) now refuses to boot
with an empty `SENDGRID_API_KEY` or malformed `MAIL_FROM` — the product IS an
email; accepting submissions it can never deliver is worse than not starting.
Also resolved the transform inconsistency the audit flagged: an unset NODE_ENV
now resolves to "production" at runtime, matching the strict posture validation
already applied. +4 env tests.

**F-13.** Docs rewritten from observed state: README's setup now matches
reality (root+api install, no `db push`, the real gate); CLAUDE.md's enforcement
section demoted to the honest three-layer story (database → repository →
guardrails) per D16; AUTH.md's role example lowercased to the schema vocabulary;
`.env.example`'s stale port comment fixed.

---

## 2026-08-30 — D15 implemented; first real migration created and PROVEN

**Schema (F-02 closed).** Shift now carries `membershipId` + denormalised
`companyId`/`userId`, all three bound by ONE composite FK against the
membership's `@@unique([id, companyId, userId])` — the database refuses a shift
whose company or user disagrees with the membership that authorised it.
`ShiftStatus` is an enum: draft/active/finishing OPEN, submitted/voided CLOSED.
Learned the hard way: Prisma requires field attributes on a single line — a
multi-line `@relation` is a P1012.

**Migration (F-03 closed).** `20260830132905_init`, generated by
`migrate diff --from-empty --to-schema` via `api/scripts/first-migration.sh`,
with `invariants.sql` (the one-open-shift partial unique index) appended so the
invariant ships inside the migration. Gotcha for posterity: the Prisma CLI
prints decorative log lines to STDOUT, so a bare `>` redirect poisons generated
SQL — the script now filters them, after Postgres rejected "◇" as a keyword.

**Proven, not asserted.** `migrate deploy` applied cleanly to a fresh database;
the partial index confirmed in `pg_indexes` WITH its WHERE clause;
`_prisma_migrations` ledger exists. **12/12 db tests** against that database,
every rejection asserted as the specific error (P2003 FK / P2002 unique), no
message-string matching. The one-open-shift invariant first proved itself by
accident — it rejected a test's second draft before the FK could — and now has
deliberate tests: a second open shift is refused even via a valid membership in
another company, and REOPENING a closed shift past a live one is refused too.
Full gate: 52/52 unit, typecheck, eslint, check-rules, validate, knip all green.

**Still deliberately undone.** Dev database `lb_timesheet` untouched (drifted;
reconcile as a conscious step). test:db still outside `check` (F-04). Nothing
committed.

---

## 2026-08-25 — `npm run check` verified green on the Mac

Full chain passes under Node 22.12.0: typecheck clean, check-rules clean, knip
finds no issues, 10/10 tests pass. The guard rails are real, not aspirational.

Phase 0 is complete. Nothing is committed to git yet.

---

## 2026-08-25 — Guard rails green; Node-version trap made loud

`npm run check` now passes end to end: typecheck, check-rules, knip (clean), 10
tests.

Two last fixes, both traceable to the same root cause — the Mac shell reverting
to Node 20:

- **`node --test` only expands globs from Node 22**, so the quoted
  `"src/**/*.test.ts"` was passed through literally and the runner reported
  "Could not find". Replaced with `$(find src -name "*.test.ts")`, which behaves
  identically on any Node and in both zsh and bash.
- **Added a Node-version guard as check #0 in check-rules**, because every
  symptom of running Node 20 here (Prisma engine errors, missing generated
  client, the glob failure above) appears far from its cause. It now says so
  directly and tells you to run `nvm use`.

The permanent fix is still nvm's directory hook in `~/.zshrc` — `.nvmrc` alone
does nothing unless something reads it.

---

## 2026-08-25 — knip config fixed; Node version keeps regressing

`npm run check` got as far as knip and stopped. Two real problems, both fixed and
re-verified in the cloud container against a stubbed `src/generated/client.ts`
so the tree shape matched the Mac's:

1. **`@prisma/client` reported unused.** It is used, but only from generated code
   that knip deliberately does not follow. Added to `ignoreDependencies`.
2. **`prisma.config.ts` could not resolve `DATABASE_URL`.** knip loads it from the
   repo ROOT, where `import "dotenv/config"` looks for `./.env` — but the file
   lives at `api/.env`. Now resolved relative to the config file itself, so it
   works whatever the cwd.

Also applied knip's own configuration hints: `src/server.ts` and
`prisma.config.ts` are auto-detected as entry points and no longer listed, and
`src/generated/**` moved from a separate `ignore` key into a `!` negation in
`project`. One informational hint remains (`.prisma` compiled extension) — it
does not fail the run.

**Recurring trap: Node version.** The Mac shell keeps reverting to v20.20.0
between sessions, so `npm install` runs under the wrong Node unless `nvm use` is
run first, every time, in every new terminal. `.nvmrc` only helps if something
reads it. Worth adding nvm's directory hook to `.zshrc` — otherwise this will
keep resurfacing as confusing Prisma failures.

---

## 2026-08-25 — Guard rails: tests, enforced rules, dead-code detection

Added before writing any real feature, on the principle that a rule nobody can
run is a suggestion.

**`api/scripts/check-rules.ts`** turns CLAUDE.md into a failing build. Nine
checks: no `any`; no `console.*` in src; no inline `reply.status(4xx)` (errors go
through `lib/errors.ts`); no `jwt.verify` outside the auth helpers; every
`z.string()` bounded with `.max()`; no empty `.catch(() => {})`; no
`String @default("")` in the schema; every tenant model carries `companyId`
(allowlist: `User`, `Company`, with reasons); every file in `src/routes/`
actually registered in `app.ts`. Escape hatch is `// rules-ignore: <id>` with a
reason.

**Tests** — 10 unit tests via `node:test`, covering environment validation and
the error envelope.

**knip** for dead code and unused dependencies, plus a root `package.json` (knip
needs one for workspaces, and web/ and mobile/ will want it shortly).

**CI** — `.github/workflows/ci.yml` runs install → typecheck → rules → knip →
db:push → tests against a real Postgres. Never executed: there is no remote repo
yet.

**Design change forced by testing.** `env.ts` called `process.exit(1)` at module
scope, so importing it from a test killed the test run. Split into
`env.schema.ts` (pure, testable) and `env.ts` (loads and exits). Worth noting as
a pattern — the side effect and the validation are now separable, which is why
the test could be written at all.

**Two bugs in the guards, caught before they reached the Mac.** check-rules
flagged the schema comment that *describes* the nullable rule (now skips comment
lines), and knip could not run without a root package.json. Both found by
executing the checks in the cloud container first rather than handing over
untested tooling.

*Caveat:* the cloud container cannot reach `binaries.prisma.sh` either, so
`prisma generate` never ran there and the full `tsc --noEmit` was verified only
across `src/lib` and `scripts` (via `tsconfig.check.json`). `app.ts` and
`server.ts` typecheck on the Mac, where the client exists.

---

## 2026-08-25 — Skeleton running end to end

`npm install`, `db:push` and `npm run dev` all succeed on the Mac under Node
22.12.0. Database in sync, API listening on :3000, `/health` served. The
skeleton is real.

Root cause of the whole run of failures was Node 20 + Prisma 7: once 22.12.0 was
in place (via the new `.nvmrc`) and `prisma.config.ts` loaded dotenv, everything
downstream resolved — including the `src/generated/client.js` not-found error,
which was only ever a symptom of `prisma generate` never having run.

**Known issue, not yet acted on.** `npm audit` reports 3 high-severity advisories,
all one chain: `prisma` → `@prisma/config` → `deepmerge-ts <8.0.0` (stack
exhaustion on recursive object graphs, GHSA-ggr8-5vv4-36mx). The only offered fix
is `--force`, which would *downgrade* to prisma 6.12.0 — a breaking change and the
wrong direction. It is a build-time CLI dependency, not something reachable from a
request, so the exposure locally is negligible. **Revisit when Prisma 8 ships**
(8.0.0-rc is already out) rather than downgrading. Do not run `npm audit fix
--force` on this repo.

**Not yet done:** nothing is committed to git. No migration files exist either —
`db:push` syncs the schema without recording a migration, which is fine for now
but must switch to `prisma migrate dev` before anything reaches a shared or
production database.

---

## 2026-08-25 — First run on the Mac: three fixes

The skeleton did not run first time. Causes and fixes:

1. **Prisma 7 removed `url` from the datasource block.** The schema had
   `url = env("DATABASE_URL")`, which 7.x rejects (P1012). Connection URLs now
   live in `prisma.config.ts` — added, matching the TMS's file exactly. The
   schema's datasource is now `provider` only; the runtime connection comes from
   the `PrismaPg` adapter, the CLI's from the config file.
2. **Port 5433 was already allocated** on the Mac, so the container could not
   bind. Moved to **5544** in docker-compose, `.env.example` and README.
3. **`node_modules` was installed from the wrong platform.** Dependencies were
   installed from the Linux sandbox shell, which wrote linux-arm64 binaries into
   the repo; esbuild then refused to run under macOS. Fixed by deleting
   `node_modules` and `package-lock.json` and reinstalling on the Mac.
   **Lesson: never run `npm install` for this repo from the sandboxed shell** —
   it also cannot reach `binaries.prisma.sh`. Installs happen on the Mac.

Also noted: interactive zsh does not treat `#` as a comment, so trailing
explanatory comments in pasted commands become arguments (`cp .env.example .env
# then set...` failed with `cp: long: Not a directory`). README updated.

---

## 2026-08-25 — Build started: repo skeleton, first schema, API boots

**Built.** `git init` on `main`. Root `.gitignore`, `docker-compose.yml`
(Postgres 16 on **port 5433** — deliberately not 5432, so it can never collide
with the TMS's database), `README.md`. `api/` with package.json (Fastify 5,
Prisma 7, zod 4, tsx — same stack as the TMS so the fork lands cleanly),
tsconfig (strict, `noUncheckedIndexedAccess`), `.env.example`.

`src/lib/env.ts` validates the environment with zod and exits with a readable
message rather than failing at first use. `src/lib/errors.ts` is the single error
envelope. `src/app.ts` + `src/server.ts` boot Fastify with CORS and rate limiting
and expose `GET /health`, which also pings the database.

**First schema** (`api/prisma/schema.prisma`, 180 lines) — Company, User,
CompanyMembership, Shift, ShiftSegment, ShiftSubmitJob. Notes:

- Multi-company from the first migration (D12). `active` lives on the membership,
  not the user.
- Times are real `DateTime`. `Shift.shiftDate` is a `@db.Date` derived from
  `startedAt`, which resolves O8 by construction — an overnight shift files under
  the day it started. **Provisional, still worth confirming.**
- A defect is a failed check item plus a note inside the checks JSON. With photos
  gone (D10) it needs no table of its own — reconsider only if the PDF's defect
  section proves awkward to build from JSON.
- Deliberately **excluded**: fuel/AdBlue (O6 unanswered) and any deliveries table
  (O2 unanswered). Both are additive later; neither blocks the skeleton.
- `ShiftSubmitJob` carries a comment explaining why the outbox exists, so nobody
  "simplifies" it back into the request handler.

**Blocked in the sandbox.** `npm install` fetched all 205 packages, but the
`postinstall` (`prisma generate`) failed — `binaries.prisma.sh` returns 403 from
the local shell's network. Not a code problem. The first real run must happen in
a Mac terminal, where Docker also lives.

**Next.** Start Postgres, push the schema, confirm `/health` returns `db: up`.
Then auth, then the shift flow.

---

## 2026-08-25 (later still) — Multi-company drivers; D6 hardened to zero sharing

**D12 — a driver can work for multiple companies.** Agency and casual driving is
normal in UK haulage, so driver identity is global with a membership per company
(the TMS's `CompanyMembership` shape). Closes O9, which had leaned the other way.
Modelled from the first migration because retrofitting it would mean migrating
every shift record. The morning flow gains a company picker that is shown **only**
to drivers holding more than one active membership, so the single-company case
loses no taps.

**D6 revised — no shared surface at all.** The earlier version kept design tokens
and check definitions shared between the two products with a "keep identical"
rule. Dropped: any shared surface means a change in one app forces a change in the
other, which is the coupling D1 exists to prevent. Parity comes from copying once
at fork time; afterwards the two apps are free to drift. Accepted cost: the
"familiar on upgrade" promise weakens over time.

**Knock-on effects.** Active/inactive becomes per membership. Check config and
destination email follow the selected company. Activation codes attach a
membership. The privacy rule hardens — Company A must never learn the driver also
works for Company B, which is now written into CLAUDE.md as a query-level rule.
And the private diary gets *more* valuable: an agency driver gets one view of
hours and earnings across every company he drives for.

---

## 2026-08-25 (later) — Retention, defect photos and data roles decided

**Decided.** D9 submitted records are kept — storage is cheap and a company that
loses the email can always re-download. D10 no defect photographs in V1; a defect
is a written description. D11 Q25 Ltd is the owning entity, and the app holds two
different data-protection roles at once — processor for employer timesheet data,
controller for the driver's private diary.

**Effect on the build.** Object storage leaves the scope entirely — with no photos
and no stored PDFs there is no heavy artifact, so the datastore is pure rows. The
submission pipeline is unblocked. The offline story gets materially easier: text
queues and syncs over bad signal; photo uploads do not.

**Docs updated.** CLAUDE.md — retention section rewritten, privacy boundary now
stated as a legal boundary rather than a preference. PRODUCT.md — defects are text
only, plus a sharper value point (three trailers on paper means three check sheets
to fill in and carry). STATUS.md — object-storage row removed, retention row
unblocked. DECISIONS.md — D9–D11 added, O1 rewritten.

**Still open.** O1 is narrower but not closed: the retention *period* needs an
actual number for the privacy policy, and there is no rule yet for what happens to
a company's records when they cancel. O2 (whether the PDF keeps a loads/ticket
section) is unchanged and still needs a deliberate answer.

---

## 2026-08-25 — Repo created, product scoped, docs seeded

**Context.** LogisticBay Timesheets was scoped out as a standalone product,
separate from the LogisticBay TMS. This repo (`~/LB-Timesheet`) was created empty
and seeded with documentation only. No code was written.

**Done**

- Surveyed the TMS (`~/timesheet-app`, `main`, 669 commits) read-only to establish
  what already exists and can be forked. Findings recorded in STATUS.md
  "Fork inventory".
- Wrote `CLAUDE.md` (identity guard + rules), `PRODUCT.md` (scope + boundary),
  `DECISIONS.md` (8 settled, 9 open), `STATUS.md` (all 🔲), this file.
- Added a matching "which project am I in?" guard block to the **TMS's**
  `CLAUDE.md` (user-approved, docs only, no code touched), so the protection
  works in both directions.

**Key finding.** Most of the driver-facing half of this product already exists
inside the TMS — shift + segment models, DVSA check lists, the full
start→check→swap→finish→submit screen flow, PDF generation, SendGrid delivery,
and a properly-built outbox/retry worker. This is largely an **extraction and
subtraction** job, not a greenfield build.

The parts with **no** TMS source at all: the driver's private salary/hours diary,
and the entire company SaaS layer (self-serve signup, subscription/billing,
activation codes, settings, retention).

**Decided this session.** D1 separate everything · D2 separate auth · D3 domain
layout with the marketing site as the only shared surface · D4 two apps rather
than one plan-gated app · D5 upgrading to the TMS is a commercial event, not a
data migration · D6 driver UX stays familiar to the TMS app · D7 company can
re-download submissions, regenerating PDFs rather than storing them · D8 fork by
copying, no git history carried over. Full reasoning in DECISIONS.md.

**Deferred / open.** O1 retention rule is **blocking** the submission pipeline.
Also open: whether the PDF keeps a loads/ticket section (O2), driver salary
history portability (O3), whether the TMS app eventually needs the salary tracker
too (O4), admin subdomain (O5), fuel/AdBlue modelling (O6), pricing (O7),
overnight shifts (O8), multi-company drivers (O9).

**Housekeeping note.** The folder was created as `LB-Timesheet ` with a trailing
space (breaks shell quoting, upsets git/npm/deploy tooling); renamed to
`LB-Timesheet` and re-connected the same day.

**Next session should.** Read STATUS.md and DECISIONS.md first. Do not start the
submission pipeline until O1 is answered. Likely first build step is the schema
plus the company web app skeleton, since that half has no TMS source and is the
critical path.
