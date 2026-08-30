# Phase 0 Audit — read-only review

*Run 2026-08-25 by a separate agent against commit `13456ac`, plus the ESLint /
prisma-validate / no-prisma-in-routes changes made immediately after it.*

**Read-only.** Nothing was modified. These are findings, not fixes — decide what
gets acted on before authentication is implemented.

Severity is stated as *what this becomes once auth and routes land on top of it*,
not what is exploitable today (nothing is: there are no routes, no auth, no data).

---

I read all 27 files and empirically tested the `check-rules.ts` regexes against bypass candidates (verification scripts written to the scratchpad only — **nothing under `/mnt/user-data/uploads/LB-Timesheet/` was read-modified, created, or deleted**; the tree is also mounted `r--r--r--`).

A calibration note on severity: nothing here is exploitable *today* — there are no routes, no auth, no data. Severities are stated as **"what this becomes the moment auth and routes land on top of it"**, which is the point of auditing now.

---

# 1. Security flaws

### 1.1 CORS reflects any origin with credentials enabled — CRITICAL
**Location:** `api/src/app.ts:12`
```ts
await app.register(cors, { origin: true, credentials: true });
```
`origin: true` makes `@fastify/cors` echo back whatever `Origin` the caller sent, and `credentials: true` sets `Access-Control-Allow-Credentials: true`. This is the maximally permissive CORS configuration that the spec still allows.

**Why it matters:** the moment `/auth/login` exists, any website the driver visits can issue a cross-origin credentialed request to `timesheets-api.logisticbay.com` and **read the response body**, because the browser will honour the reflected origin. D3 assumes "Bearer tokens in browser storage are origin-scoped and safe by default" — that reasoning holds for the *token*, not for the *responses*, and it collapses entirely if auth ever moves to cookies, which D3 itself contemplates. There is no `CORS_ORIGIN` variable in `env.schema.ts`, so there is not even a configuration slot to fix this in; whoever fixes it has to add env plumbing first, which is exactly the friction that makes bad defaults survive.

**Suggested direction:** add `WEB_ORIGIN` to `EnvSchema` and pass an explicit allowlist (`https://timesheets.logisticbay.com` plus a localhost dev origin), and set `credentials` only if a cookie flow is actually adopted.

### 1.2 `JWT_SECRET` validation is length-only, and `.env.example` ships a value engineered to pass it — HIGH
**Location:** `api/src/lib/env.schema.ts:9`, `api/.env.example:5`
```ts
JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters").max(500),
```
`"change-me-to-a-long-random-string"` is 33 characters. It validates.

**Why it matters:** the one guard that exists is satisfied by the literal placeholder. A deploy that copies `.env.example` into a production secret store boots green with a globally known signing key — total auth bypass, and it produces no warning anywhere. Contrast the care taken over `mailDisabled` (`env.ts:27`), which *does* get a boot-time warning for a far less severe misconfiguration.

**Suggested direction:** reject the known placeholder values outright, and in `NODE_ENV === "production"` additionally require a minimum Shannon entropy or a base64/hex shape rather than a character count.

### 1.3 Nothing forbids production booting with email silently disabled — HIGH
**Location:** `api/src/lib/env.schema.ts:10`, `api/src/lib/env.ts:27`, `api/src/server.ts:25`
`SENDGRID_API_KEY` defaults to `""` in every environment, and the only consequence is `app.log.warn(...)` at boot.

**Why it matters:** the entire product is "Paper form → phone → PDF → **company email**" (PRODUCT.md). A production instance with a missing key accepts submissions, writes `ShiftSubmitJob` rows, and delivers nothing — a total product failure whose only symptom is one warn line in a log nobody reads on day 400. Drivers will believe their timesheets were filed. For walkaround checks this is an operator-licence record that silently never arrived.

**Suggested direction:** make the schema conditional — `SENDGRID_API_KEY` optional in `development`/`test`, required and non-empty in `production`, via a `superRefine` on `NODE_ENV`.

### 1.4 No global error handler or 404 handler — the "one error envelope" rule is broken by default, not by developers — HIGH
**Location:** `api/src/app.ts:7-27` (absent), `api/src/lib/errors.ts`
`buildApp` never calls `app.setErrorHandler` or `app.setNotFoundHandler`.

**Why it matters:** every error the helpers in `errors.ts` do *not* produce — an unhandled throw in a service, a Fastify schema-validation 400, any 404, a `FST_ERR_*` — returns Fastify's own `{ statusCode, error, message }` shape. So the contract CLAUDE.md calls "One error envelope" is already violated on the majority of error paths, and `check-rules`' `error-envelope` rule cannot see it because there is no `reply.status(4xx)` line to match. Clients will be written against two envelopes. Fastify validation errors also leak schema internals in `message`.

**Suggested direction:** register `setErrorHandler`/`setNotFoundHandler` in `buildApp` that funnel through `errors.ts`, and log-then-mask anything that is not a known operational error.

### 1.5 Rate limiting is one global bucket and will be wrong behind a proxy — MEDIUM
**Location:** `api/src/app.ts:13`, `api/src/server.ts:23`
```ts
await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
```
No `keyGenerator`, and Fastify is constructed without `trustProxy` (`app.ts:8`) while listening on `0.0.0.0` behind a platform load balancer.

**Why it matters:** two failure modes at once. Without `trustProxy`, `req.ip` is the load balancer's address, so *every user in the world shares one 300/min bucket* — a self-inflicted denial of service at trivial traffic, and health checks compete for the same budget. And if `trustProxy` is later switched on without a per-route override, 300 requests/minute is a generous **password-guessing and `joinCode`-brute-forcing budget** (see 2.4). The in-memory store also means limits are per-instance on any multi-instance deploy.

**Suggested direction:** set `trustProxy` from env, keep a modest global limit, and register a far tighter per-route limit on the auth and join-code routes when they are written.

### 1.6 Database error swallowed in `/health` — LOW, but it is the precedent
**Location:** `api/src/app.ts:17`
```ts
const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
```
The reason the connection failed is discarded. `check-rules`' `no-empty-catch` rule does not fire (verified — see 8.6), so the codebase's very first error-swallow is invisible to the rule written specifically to prevent error-swallowing.

**Why it matters:** less about `/health` than about what it teaches. This is the file a developer copies from.

### 1.7 No security headers, and no logger redaction — LOW/MEDIUM
**Location:** `api/src/app.ts:8-13`
No `@fastify/helmet` (not even a dependency), and `logger: true` in production with no `redact` paths. Fastify's default request serializer does not log headers, so nothing leaks today — but the first developer who adds a custom `reqSerializer` or logs a request body has no guard rail, and auth bodies contain passwords.

**Suggested direction:** add `redact: ["req.headers.authorization", "req.body.password", "req.body.pin"]` now, before there is anything to redact.

---

# 2. Tenant-isolation risks

### 2.1 `companyId` is denormalised onto child rows with no constraint keeping it truthful — HIGH
**Location:** `api/prisma/schema.prisma:121` + `145-146` (`ShiftSegment`), `163` + `174-175` (`ShiftSubmitJob`)
```prisma
model ShiftSegment {
  companyId    String
  shiftId      String
  ...
  company      Company  @relation(fields: [companyId], references: [id])
  shift        Shift    @relation(fields: [shiftId], references: [id], onDelete: Cascade)
```
Two independent foreign keys. Nothing in the database requires that `segment.companyId == segment.shift.companyId`. Same shape on `ShiftSubmitJob`.

**Why it matters:** this is the highest-probability real tenant leak in the schema. A service that writes a segment while holding the wrong `AuthContext`, or that takes `companyId` from one place and `shiftId` from another, creates a row that is genuinely inconsistent — and then **both** scoping strategies are correct and disagree. A company-facing query filtered on `ShiftSegment.companyId` will return a segment belonging to another company's shift; a query that joins through `Shift` will not. The PDF regeneration path (D7) joins through `Shift`; a defect list screen would likely filter on `companyId` directly. Worse, `check-rules`' `tenant-scoped` rule reports these models as compliant, which converts a real gap into positive reassurance.

**Suggested direction:** add `@@unique([id, companyId])` to `Shift` and point the child relations at the composite key (`fields: [shiftId, companyId], references: [id, companyId]`), so the database makes the inconsistent row unrepresentable.

### 2.2 A `Shift` can be written for a `User` who has no membership in that `Company` — HIGH
**Location:** `api/prisma/schema.prisma:84-115`
`Shift` carries `companyId` and `userId` as two separate FKs. There is no `membershipId`, and no constraint requiring that `(companyId, userId)` corresponds to an existing `CompanyMembership` row.

**Why it matters:** CLAUDE.md is explicit — *"Every company-facing query filters by the membership the request is scoped to, never by driver alone."* The schema cannot express that query. A "membership-scoped" read has to be manually decomposed into `where: { companyId, userId }`, which is a *different* predicate that happens to coincide only while the data is consistent. It also breaks AUTH.md's revocation story: if a driver is removed from Company A and later re-added, his old shifts silently reattach to the new membership; and there is no way to ask "which shifts did this membership produce" for a subject-access request, which D11 says you owe.

**Suggested direction:** add `membershipId` to `Shift` as the authoritative tenant link (keeping `companyId` for index locality), with a composite FK back to `CompanyMembership(id, companyId)`.

### 2.3 No index supports the most common company-facing query — MEDIUM
**Location:** `api/prisma/schema.prisma:112-114`
```prisma
@@index([companyId, shiftDate])
@@index([companyId, status])
@@index([userId, shiftDate])
```
There is no `@@index([companyId, userId, shiftDate])`. The only index that makes "this driver's shifts" cheap is `[userId, shiftDate]` — which spans **every company he drives for**.

**Why it matters:** this is a performance gradient pointing at a privacy violation. A developer writing the company's "driver history" screen will find that filtering by `userId` is fast and filtering by `companyId + userId` is not, and the query planner will nudge them toward the leaky shape. CLAUDE.md calls Company A learning about Company B a *legal* boundary, not a preference. The index set should make the safe query the fast one.

### 2.4 `Company.joinCode` is a plaintext, never-expiring, unbounded, company-wide credential — HIGH
**Location:** `api/prisma/schema.prisma:29`
```prisma
joinCode String @unique
```
No length constraint, no format, no expiry, no rotation, no per-invite scoping, no usage counter.

**Why it matters:** D12 says *"Activation codes attach a membership"* — so this string is the sole thing standing between a stranger and a `CompanyMembership` in a company whose timesheets they can then read and submit. It is globally unique across all tenants, which makes it directly enumerable: guessing *any* valid code gets you into *some* company. With the global 300/min limiter of 1.5 and no per-code lockout, a short code is brute-forceable. Nothing in the schema caps its length, so "4 digits" is a legal implementation.

**Suggested direction:** treat this as a credential — store it hashed, give it an explicit length/charset and an expiry, and consider a separate `Invite` model with a one-time or bounded-use code rather than a permanent company-wide secret.

### 2.5 `User.email` uniqueness is case-sensitive — MEDIUM
**Location:** `api/prisma/schema.prisma:47`
Postgres `text` unique indexes are case-sensitive, so `Nerijus@haulage.co.uk` and `nerijus@haulage.co.uk` are two distinct users.

**Why it matters:** duplicate identities for the same human, each with its own memberships and its own private diary — which then splits the cross-company diary that D12 calls the product's main personal upside. It also creates an account-confusion surface at login and password reset. Cheap now, migration-with-merge-logic later.

**Suggested direction:** store email normalised (lowercased) on write plus a `@@unique` on a normalised column, or a Postgres `citext`/functional unique index in the first migration.

### 2.6 The seed/scripts directory is entirely outside every rule's scope — MEDIUM
**Location:** `api/scripts/check-rules.ts:55` (`const files = walk(SRC)`), `api/package.json:15`
`walk()` only ever traverses `api/src`. `api/scripts/` is never scanned — and `package.json` already declares `"seed": "tsx scripts/seed.ts"` for a file that does not exist yet.

**Why it matters:** a seed script is precisely where multi-tenant fixture data gets created, where `any` proliferates, and where someone will hard-code a `DATABASE_URL`. It is the one place with unmediated write access to every tenant's rows, and it is the one place with zero enforcement.

---

# 3. Auth-contract drift

The honest headline: **STATUS.md correctly marks the Session model and auth implementation as 🔲**, so this is not a case of docs lying about state. The drift is in the things AUTH.md's frozen contract needs that nobody has noticed are missing or actively obstructed.

### 3.1 The `Session` model will be pushed toward the wrong shape by `check-rules` — HIGH
**Location:** `api/scripts/check-rules.ts:148-165`
AUTH.md is emphatic: *"**Session** | One authenticated device/login. **Survives company switching.**"* A Session therefore must **not** carry `companyId`. But rule 8 flags every model lacking a `companyId` field unless it is listed in `GLOBAL_MODELS`, which today contains only `User` and `Company`.

**Why it matters:** the developer implementing AUTH.md hits a red build and has two one-line fixes: add `companyId String` to `Session` (green, and silently breaks the frozen contract — sessions now belong to a company and cannot survive a switch), or edit `GLOBAL_MODELS` (green, correct). The linter makes the wrong answer the more obvious one. I verified the rule's behaviour: a `Session` model with `userId` but no `companyId` is flagged. This is a guard rail steering into the wall.

**Suggested direction:** pre-add `Session` to `GLOBAL_MODELS` with the reason *now*, before it is written, so the trap never springs.

### 3.2 Nothing supports session invalidation on password change — MEDIUM
**Location:** `api/prisma/schema.prisma:45-55`
`User` has `passwordHash` but no `passwordChangedAt`. AUTH.md gives refresh tokens a **90-day TTL**, and CLAUDE.md lists "invalidating sessions" among the things you must stop and ask about.

**Why it matters:** with a 90-day refresh and no `passwordChangedAt`, a driver who changes their password because they think they were compromised does not evict the attacker — the stolen refresh token keeps minting 15-minute access tokens for three months. The standard fix (reject sessions issued before `passwordChangedAt`) needs a column that does not exist. The web app's "Change password" is already on the roadmap (STATUS.md, Company web app).

### 3.3 No structure for login throttling or lockout — MEDIUM
**Location:** `api/prisma/schema.prisma:45-55`
No `failedLoginAttempts`, no `lockedUntil`, no last-login-at. AUTH.md contract test 4 requires *"wrong password → 401, response identical in shape to unknown-email"* — good, that is anti-enumeration — but nothing anywhere limits how many times you can ask. The only limiter is the shared global bucket of 1.5.

### 3.4 The "one open shift" invariant AUTH.md depends on is not representable — HIGH
**Location:** `api/prisma/schema.prisma:84-115`, `AUTH.md:135-137`
AUTH.md: *"A switch is refused while the driver has an open (draft) shift. **One open shift at a time**; 'which company is this shift for' must never be ambiguous."* The schema has no unique constraint over `(userId, status = 'draft')`.

**Why it matters:** the invariant that makes the company-switch rule *meaningful* is enforced only by whatever the service layer remembers to do. Two concurrent submits from a phone with flaky signal (PRODUCT.md's stated normal condition) will create two drafts, and then the refusal check itself becomes ambiguous — which is the exact ambiguity AUTH.md wrote the rule to prevent. Application-level checks lose this race; the database does not.

**Suggested direction:** a partial unique index in the first migration — `CREATE UNIQUE INDEX ... ON "Shift" ("userId") WHERE status = 'draft'` — added as raw SQL since Prisma cannot express it declaratively.

### 3.5 `iss`/`aud` have no configuration home — LOW/MEDIUM
**Location:** `api/src/lib/env.schema.ts:7-14`
AUTH.md and D13 both stress that `iss: "logisticbay-timesheets"` / `aud: "timesheets-api"` are *"D1 enforced in the token format itself"* — the structural barrier against a TMS token. `EnvSchema` has no `JWT_ISS`/`JWT_AUD`, so these will be hardcoded string literals, and CLAUDE.md's "One status string registry" rule (which `check-rules` does not implement at all — see 8.11) is the only thing that would stop them being retyped inconsistently in the signer and the verifier. A typo in one of them silently disables the protection while every test still passes.

### 3.6 Zero of AUTH.md's 25 contract tests exist — HIGH (see §6)
AUTH.md:180 says *"Contract tests — **write these before the implementation**"*. None are written. This is not a rule violation yet (the implementation is 🔲), but the instruction was to write them first and the first opportunity to comply has already passed once.

---

# 4. Missing validation

### 4.1 `truckChecks` / `trailerChecks` are unbounded, unstructured JSON — HIGH
**Location:** `api/prisma/schema.prisma:138-139`
```prisma
truckChecks   Json?
trailerChecks Json?
```
No size bound, no shape, no schema. The documented contents — `[{ key, label, result: pass|fail|na, note }]` — live only in a comment.

**Why it matters:** three separate consequences. (a) **Defects are not queryable.** A defect is *"a failed item with a note"* buried inside a JSON blob, so "show this company's open defects" — the single most operationally valuable company-facing view, and the thing that makes the walkaround record worth keeping — requires scanning and parsing every segment. (b) **Retention (O1) cannot be applied selectively.** DECISIONS O1 anticipates different periods for check records (~15 months, operator-licence) and timesheets (~6 years, payroll); those two datasets are currently the same rows. (c) **It is the one unbounded write path.** Every rule in CLAUDE.md about capping strings is defeated by putting the strings inside a `Json` column — the `zod-max` rule cannot see inside a nested object, and Fastify's default 1 MB `bodyLimit` becomes the only cap.

**Suggested direction:** at minimum, validate the array with a bounded Zod schema (`.max()` on the array length *and* on each `note`) before write; better, promote failed items to a real `Defect` row so the legal record is a row, not a substring.

### 4.2 No `.max()` equivalent anywhere in the schema — MEDIUM
**Location:** `api/prisma/schema.prisma` throughout
CLAUDE.md specifies precise caps (free text 4000, codes 64, names 200, emails 320, registrations 16), but not one column uses `@db.VarChar`. `Company.name`, `User.name`, `payrollRef`, `truckReg`, `trailerReg`, `driverName`, `notes`, `joinCode`, `lastError` are all unbounded Postgres `text`.

**Why it matters:** the caps are enforced only by Zod, and Zod is enforced only by a line-based regex I have demonstrated is trivially evaded (8.5). Defence in depth costs one annotation per column here and a table rewrite later.

### 4.3 `ShiftSubmitJob` has no unique constraint on `shiftId` — HIGH
**Location:** `api/prisma/schema.prisma:162-179`
```prisma
@@index([status, nextAttemptAt])
@@index([companyId, shiftId])
```
Both are non-unique indexes. Nothing prevents two pending jobs for the same shift.

**Why it matters:** STATUS.md's fork inventory flags this model as carrying **"idempotency"** and warns *"Written after PDFs went missing on Railway redeploys — carry the solution, don't rediscover the bug."* The solution's idempotency was carried across as a *comment*, not as a constraint. A retried submit from an offline phone — PRODUCT.md's explicit requirement of *"protection against duplicate submissions"* — enqueues twice and the customer receives the same timesheet PDF twice. There is also no idempotency key on `Shift` itself, so the duplicate-protection requirement has no schema representation at all.

**Suggested direction:** `@@unique([shiftId])` on the outbox (one submission per shift), plus a client-supplied idempotency key on `Shift` with a unique index.

### 4.4 Inconsistent and probably wrong cascade rules — MEDIUM
**Location:** `api/prisma/schema.prisma:71-72` vs `107-108`, `145`, `174`
```prisma
// CompanyMembership
company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
user    User    @relation(fields: [userId],    references: [id], onDelete: Cascade)
// Shift — no onDelete specified
company Company @relation(fields: [companyId], references: [id])
user    User    @relation(fields: [userId],    references: [id])
```
Prisma defaults a required relation to `onDelete: Restrict`. So deleting a `Company` **cascades** its memberships but is **blocked** by its shifts, and the same for `User`.

**Why it matters:** two problems. First, deleting a `User` cascades away every `CompanyMembership` — which destroys, without warning, the authorisation history for shifts that survive. Second, the mixture means "delete this company" is an operation that half-succeeds in a way nobody has reasoned about, and O1 (*"What happens when a company cancels"*) is explicitly open. CLAUDE.md's "When in doubt, stop and ask" list names *"changing the data-retention behaviour"* — an implicit `Restrict` chosen by omission is a retention decision made by default rather than deliberately.

**Suggested direction:** make every referential action explicit in the schema (even where the default is right) so the choice is visible in review, and hold the actual cascade semantics until O1 is answered.

### 4.5 `Company.reportEmail` is nullable with no enabled-flag and no validation — MEDIUM
**Location:** `api/prisma/schema.prisma:27`
STATUS.md's fork inventory lists the TMS source as `Company.reportEmail` **/ `reportEmailEnabled`** — the second field was dropped without comment.

**Why it matters:** a company can exist, drivers can submit, and `ShiftSubmitJob` rows can be written with no destination address. The worker then fails permanently, burns through `attempts`, and marks the job `failed` — the driver's day is recorded but never delivered, and the failure mode is identical to "email not yet configured" and "email configured wrong". There is also no format validation, so a typo'd address produces bounces the app never learns about.

### 4.6 `shiftDate` has no timezone anchor while O8 is open — MEDIUM
**Location:** `api/prisma/schema.prisma:92-94`
```prisma
/// derived from startedAt, so a 22:00 → 06:00 shift files under the day it STARTED (O8, provisional).
shiftDate DateTime @db.Date
startedAt DateTime
```
`startedAt` is a UTC instant; `shiftDate` is a bare date; nothing records the timezone the derivation used.

**Why it matters:** the UK is UTC+1 for seven months of the year. A shift starting 00:30 BST on 2 July is 23:30 UTC on 1 July — derive naively and it files under the wrong calendar day, on a payroll document. The comment marks O8 as *provisional* but the column is already being created as if it were settled, and DECISIONS explicitly says O8 *"affects the data model"*.

**Suggested direction:** either derive in `Europe/London` explicitly and document that as the rule, or defer the column until O8 is answered — do not ship a provisional derived column that payroll will read.

### 4.7 No length bound on `lastError` — LOW
**Location:** `api/prisma/schema.prisma:169`
Workers write provider errors and stack traces here. Unbounded `text`, and SendGrid errors routinely echo the recipient address — meaning tenant PII lands in a column that no retention policy covers.

---

# 5. Dead code / unused exports / redundant config

### 5.1 `api/tsconfig.check.json` is referenced by nothing — LOW
**Location:** `api/tsconfig.check.json`
No script in either `package.json` passes `-p tsconfig.check.json`. `typecheck` is a bare `tsc --noEmit`, which uses `tsconfig.json`. Dead file; `knip` does not check tsconfig files, so it will never be reported.

### 5.2 `"seed": "tsx scripts/seed.ts"` points at a nonexistent file — LOW
**Location:** `api/package.json:15`. `api/scripts/` contains only `check-rules.ts`.

### 5.3 `api`'s `lint` script cannot run — MEDIUM
**Location:** `api/package.json:21` (`"lint": "eslint ."`)
`eslint`, `@eslint/js` and `typescript-eslint` are declared **only in the root** `package.json:16-19`, and `eslint.config.js` lives only at the root. `npm run lint --prefix api` fails with "eslint: not found".

### 5.4 `prisma` (the CLI) is a production dependency — MEDIUM
**Location:** `api/package.json:34`
`prisma` sits in `dependencies` alongside `@prisma/client`, so the full CLI and its engines ship to production. This is partly forced by `"postinstall": "prisma generate"` (line 9) needing it at install time — but it means a production image carries `prisma db push` and `prisma migrate reset` capability against the live database.

### 5.5 Four dependencies exist only to be ignored by the dead-code checker — MEDIUM
**Location:** `knip.json:7-15`
```json
"ignoreDependencies": ["@prisma/client","@sendgrid/mail","pdfkit","@types/pdfkit","@fastify/jwt","bcryptjs","@types/bcryptjs"]
```
`@sendgrid/mail`, `pdfkit`, `@fastify/jwt` and `bcryptjs` are installed for code that does not exist. `@prisma/client` is a legitimate entry (consumed via generated output).

**Why it matters:** CLAUDE.md's "Register what you create" rule says *"Files written and never imported are deleted on sight."* The dependency equivalent was handled the opposite way — install speculatively, then silence the tool that would have said so. The allowlist has no expiry, so it will also stay silent on the day one of these becomes genuinely unused again. `bcryptjs` is worth a second look on its own merits: it is the pure-JS implementation, roughly an order of magnitude slower than `bcrypt`/`argon2` at equivalent cost factors, which pushes implementers toward a low work factor.

### 5.6 `knip`'s entry configuration makes dead exports permanently invisible — MEDIUM
**Location:** `knip.json:5`
```json
"entry": ["scripts/**/*.ts", "src/**/*.test.ts"]
```
Test files are declared as **entry points**, so anything a test imports counts as reachable. Concretely: `forbidden`, `notFound`, `conflict` and `serverError` in `errors.ts:22-25` have **zero production callers** — their only consumer is `errors.test.ts`. Knip reports clean.

**Why it matters:** the tool is configured such that writing a test for a function guarantees it can never be flagged as dead, which inverts what the check is for. Here the exports are justified (they are the envelope's API surface), but the configuration means a genuinely abandoned module with a surviving test will stay green forever.

### 5.7 Redundant logger ternary — LOW
**Location:** `api/src/app.ts:9`
```ts
logger: env.NODE_ENV === "development" ? { transport: undefined, level: "info" } : true,
```
`{ transport: undefined, level: "info" }` and `true` both yield a default pino logger at level `info`. The branch distinguishes nothing. It also means the test environment logs at full volume, and there is no `redact` in either branch (1.7).

### 5.8 `outDir`/`rootDir` are dead configuration — LOW
**Location:** `api/tsconfig.json:7-8`
There is no `build` script anywhere; `start` runs `tsx src/server.ts` directly. Nothing is ever emitted to `dist`. (See 9.4 for why that matters beyond tidiness.)

### 5.9 `Env` is exported from two modules — LOW
**Location:** `api/src/lib/env.ts:3` re-exports `type Env` already exported from `env.schema.ts:16`. Two import paths for one type is a mild "one concept, one name" wobble.

---

# 6. Test gaps

Ranked by what actually matters. Note the honest baseline: 10 tests for `env.schema.ts` and `errors.ts` is proportionate coverage *of the two modules that have tests*.

### 6.1 `check-rules.ts` — the enforcement mechanism — has zero tests — HIGH
**Location:** `api/scripts/check-rules.ts` (400 lines of regex, no test file)
Every rule in CLAUDE.md rests on this script. Nothing asserts that any rule *fires*. A regex that silently stops matching — through a refactor, a Node regex-engine change, or a well-meant "simplification" — degrades to a permanent pass, and the build stays green forever while the rule is gone.

**Why it matters most:** every other guarantee in the repo is downstream of this file. And §8 demonstrates that several rules already do not catch what they claim to — a fixture-based test would have surfaced that on day one. The specific behaviours unprotected: that each rule catches a canonical violation, that `rules-ignore` suppresses exactly one rule on exactly one line, and that a model the `^model (\w+) \{` regex fails to parse is *reported* rather than silently skipped (see 8.8).

**Suggested direction:** a fixture directory with one known-bad and one known-good sample per rule, asserting the exact violation IDs produced.

### 6.2 `buildApp` is never instantiated in a test — HIGH
**Location:** `api/src/app.ts` (no `app.test.ts`)
Nothing exercises `buildApp`, so nothing verifies: that `/health` returns `degraded` when the database is down, that CORS is configured as intended (1.1 would have been caught by a single test asserting a rejected origin), that the rate limiter is registered, or — most importantly — **that an error thrown inside a handler comes back in the `{ error, code?, details? }` envelope**. `fastify.inject()` makes all of these one-liners with no server or database needed.

### 6.3 The error envelope is tested against a hand-rolled double, not Fastify — MEDIUM
**Location:** `api/src/lib/errors.test.ts:8-15`
```ts
const reply = { status(code){...}, send(body){...} } as unknown as FastifyReply;
```
The tests prove that `send()` builds the right object literal. They do not prove that the object survives Fastify's serialisation, that `reply.status()` chains as assumed on a real reply, or — the actual risk — that these helpers are what a client sees, given that Fastify's default error and 404 handlers bypass them entirely (1.4). The test asserts the intent and is blind to the gap.

Worth noting separately: line 13 uses `as unknown as FastifyReply` — precisely the unvalidated double-cast CLAUDE.md forbids (*"`as Type` only immediately after a Zod parse, a `typeof` narrow, or an `instanceof` check"*), and neither `check-rules` nor a CI-run eslint catches it. It is defensible in a test double, but it is an unmarked exception to a stated rule.

### 6.4 Zero of AUTH.md's 25 contract tests exist — HIGH
**Location:** `AUTH.md:180-225`
The document instructs *"write these before the implementation"*. Tests 15–17 (tenant isolation) and 19–20 (the refresh grace window) are the ones that will be silently wrong if written after the fact, because they are the ones where a plausible-looking implementation passes casual manual testing.

### 6.5 No schema-level tests — MEDIUM
Nothing asserts that the constraints that *do* exist behave as expected: that `@@unique([companyId, userId])` blocks a duplicate membership, that `@@unique([shiftId, sequence])` blocks a duplicate segment, or that the cascade rules of 4.4 do what someone intended. CI already stands up a real Postgres (`ci.yml:19-30`) and pushes the schema, so the infrastructure for this is present and unused — the database is provisioned and then only two pure-function test files run against it.

### 6.6 `env.ts`'s exit-on-failure path and `mailDisabled` are untested — LOW
`env.schema.ts` is well covered. `env.ts` — the module with the `process.exit(1)` and the `mailDisabled` derivation — is not imported by any test. Low severity, but the split was made specifically to isolate the testable half and the untestable half was then left alone.

---

# 7. Unsafe defaults

1. **`origin: true, credentials: true`** — the permissive extreme, chosen by default (1.1). **CRITICAL.**
2. **No auth by default at the routing layer** — see 10.1. Adding a route with no `preHandler` yields a public route, and nothing objects. AUTH.md's *"Default is deny"* has no structural expression. **HIGH.**
3. **`SENDGRID_API_KEY` defaults to `""` in production** (`env.schema.ts:10`) — the product's core function defaults to off (1.3). **HIGH.**
4. **`Company.status @default("trial")`** (`schema.prisma:31`) — a company row is usable the instant it exists. Correct for self-serve signup, but with subscription enforcement 🔲 it means the permissive state is also the default state, and `past_due`/`cancelled` currently have no behavioural consequence anywhere.
5. **Prisma's implicit `onDelete: Restrict`** on `Shift`'s relations (4.4) — a retention-affecting default arrived at by omission.
6. **`max: 300` per minute, globally** (`app.ts:13`) — permissive for auth endpoints, and simultaneously restrictive in the wrong dimension behind a proxy (1.5).
7. **`MAIL_FROM` defaults to `timesheets@logisticbay.com`** (`env.schema.ts:11`) — a real production-looking sender address is the default in every environment including local dev, with no `.email()` validation. A misconfigured dev box sends mail that looks authentic.
8. **`.env.example` ships a `JWT_SECRET` that passes validation** (1.2).

---

# 8. Rule bypasses — `check-rules.ts` read adversarially

I ran each rule's actual regex against candidate evasions. Results below are **verified output**, not inspection.

```
BYPASS  no-any         const m: Record<string, any> = {};
BYPASS  no-any         type Loose = any;
BYPASS  error-envelope return reply.code(403).send({ error: 'nope' });
BYPASS  error-envelope const s = 401; return reply.status(s).send({error:'x'});
BYPASS  error-envelope return res.status(403).send({ error: 'nope' });
BYPASS  jwt-centralised  const claims = await request.jwtVerify();
BYPASS  zod-max        ref: z.coerce.string(),
BYPASS  zod-max        free: z.string().max(10_000_000),
BYPASS  no-empty-catch await x().catch(() => false);
BYPASS  no-empty-catch try { risky(); } catch {}
BYPASS  no-client-tenant  const { companyId } = req.body;
BYPASS  no-client-tenant  const b = req.body; const cid = b.companyId;
BYPASS  no-prisma-in-routes  import { prisma } from '../lib/db.js';
FALSE-POSITIVE zod-max  name: z.string()          ← a correct multi-line chain
```

### 8.1 `no-client-tenant` fails on the most idiomatic form — CRITICAL
**Location:** `api/scripts/check-rules.ts:175-176`
```ts
return /\b(req|request)\s*\.\s*(body|query|params)\b[^;]*\b(companyId|membershipId|userId)\b/.test(code)
    || /\b(body|query|params)\s*\.\s*(companyId|membershipId|userId)\b/.test(code);
```
`const { companyId } = req.body;` **passes**. The first pattern requires `companyId` to appear *after* `req.body` on the line; in a destructure it appears before. The second requires a literal `.companyId` member access, which a destructure does not produce. Renaming the variable (`const b = req.body; ... b.companyId`) also passes, as does the `[^;]*` guard breaking on any intervening semicolon.

**Why it matters:** this is the single most consequential finding in the audit. AUTH.md:172-177 states the guarantee in these exact terms — *"A `companyId`, `membershipId` or `userId` arriving in a request body, query or path is **never** authority. **Enforced mechanically:** `check-rules` fails the build if anything under `src/routes/` reads them from the request."* The frozen contract cites this rule as the mechanism that makes the whole tenant model safe, and the mechanism does not catch object destructuring — the way essentially every Fastify handler reads a body. The contract's confidence is unearned.

**Suggested direction:** stop pattern-matching source text for this. Make it structurally impossible instead — have the request-body Zod schemas be the only way to read a body and assert (in a test over the schema registry) that no schema declares a `companyId`/`membershipId`/`userId` key. Failing that, at minimum add a destructuring pattern and widen beyond `req|request`.

### 8.2 `no-prisma-in-routes` is defeated by the standard singleton pattern — HIGH
**Location:** `api/scripts/check-rules.ts:189-191`
It matches only a direct import from `generated/client` or `@prisma/client`, or `new PrismaClient`. The near-universal pattern — `src/lib/db.ts` exporting a shared client, imported as `import { prisma } from "../lib/db.js"` — sails through. The rule's own comment says *"A route that can reach the database can also forget to scope the query"*, and the route can still reach the database.

### 8.3 `jwt-centralised` misses the API this project will actually use — HIGH
**Location:** `api/scripts/check-rules.ts:108`
The dependency list includes `@fastify/jwt` (`api/package.json:26`), whose verification API is **`request.jwtVerify()`** and `app.jwt.sign()`. The regex looks for `jwt.verify(` and the string `jsonwebtoken`. `await request.jwtVerify()` in any route file is invisible. The rule is written against a library the project does not use.

### 8.4 `error-envelope` misses `reply.code()` — HIGH
**Location:** `api/scripts/check-rules.ts:100`
`reply.code(403)` is Fastify's own documented alias for `reply.status(403)` and appears throughout Fastify's docs — so the most likely way a developer writes an inline error is the way the rule does not check. Variable status codes and a differently-named reply parameter (`res`, `r`) also pass. The file exemption `!file.endsWith("errors.ts")` matches any file ending in those characters, e.g. `auth-errors.ts`.

### 8.5 `zod-max` has both a trivial bypass and a false positive that will get it disabled — HIGH
**Location:** `api/scripts/check-rules.ts:116-121`
Same-line matching only. So:
- **False positive (the dangerous half):** a *correct* multi-line schema —
  ```ts
  name: z.string()
    .trim()
    .max(200),
  ```
  — fails the build. This is idiomatic Zod, it is what CLAUDE.md's own instruction ("User-visible strings also `.trim()`") produces, and it is exactly the kind of wrong-and-loud failure that trains developers to reach for `// rules-ignore: zod-max` reflexively. Once that reflex forms, the rule is dead everywhere.
- **Bypasses:** `z.coerce.string()` is not matched at all (the regex requires `z` immediately before `.string`). And `.max(10_000_000)` satisfies the rule — no value is checked against CLAUDE.md's specified caps (4000 / 64 / 200 / 320 / 16), so the rule enforces the *presence* of a bound, not a *sane* one.
- **Not covered at all:** `z.array()` with no `.max()`. Unbounded arrays are the real DoS vector for this product's payload shape (segments, and the check-item arrays of 4.1) — an array of 500,000 bounded strings passes every rule in the file.

### 8.6 `no-empty-catch` matches one exact literal — HIGH
**Location:** `api/scripts/check-rules.ts:127`
```ts
line => /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(line),
```
Requires literally `.catch(() => {})`. Every practical variant escapes: `.catch(() => false)`, `.catch(() => null)`, `.catch(e => {})`, `.catch(() => { /* ignore */ })`. And **`try { ... } catch {}` — a bare statement-form empty catch — is not considered at all**, which is the more common way to swallow an error in synchronous code. The codebase's only error-swallow (`app.ts:17`, `.catch(() => false)`) is already invisible to its own rule.

### 8.7 `no-any` misses the two most common real-world forms — HIGH
**Location:** `api/scripts/check-rules.ts:84`
`Record<string, any>` and `type X = any` both pass (verified). `Record<string, any>` is the archetypal escape hatch for exactly the kind of code this repo is about to write — parsing JSON check payloads. Also unaddressed: CLAUDE.md forbids *"unvalidated casts"* as well as `any`, and `as unknown as T` — the standard way to launder a bad type — is not checked. `errors.test.ts:13` already uses it.

`@typescript-eslint/no-explicit-any` (included in `recommendedTypeChecked`, `eslint.config.js:15`) *would* catch `Record<string, any>` — **but CI never runs eslint** (9.2). So in CI, the leaky regex is the only enforcement of a rule CLAUDE.md calls mandatory. Neither tool checks for `// eslint-disable-next-line`, so an eslint suppression is itself an unaudited bypass.

### 8.8 `tenant-scoped` silently skips models it fails to parse, and only checks for a column *name* — HIGH
**Location:** `api/scripts/check-rules.ts:153-165`
```ts
for (const match of schemaText.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
```
Verified: `model  Spaced {` (two spaces) and a brace on the next line are **never seen by the rule at all** — not flagged, not reported, just absent. A formatting difference removes a model from the tenant audit with no signal. There is no cross-check that the number of models matched equals the number of models present.

And when it does match, the check is `/^\s*companyId\s+/m.test(body)` — the presence of a field *named* `companyId`. Verified: `companyId String?` with **no relation, no index, and nullable** passes. So "tenant-scoped ✓" means "contains that identifier", not "is scoped". This is what makes 2.1 dangerous rather than merely imperfect: the rule affirms the two models with the broken denormalisation.

### 8.9 `route-registered` is satisfied by a comment, and misses subdirectories — MEDIUM
**Location:** `api/scripts/check-rules.ts:200`, `208`
`readdirSync(routesDir)` is non-recursive, so `src/routes/admin/drivers.ts` is never checked. And the registration test is `appText.includes("routes/" + base)` — a line `// TODO: register routes/shifts` in `app.ts` satisfies it. Line 206 also does an unguarded `readFileSync(join(SRC, "app.ts"))` which throws an unhandled exception if `app.ts` is ever renamed.

### 8.10 The `rules-ignore` escape hatch requires no reason and is matched by substring — MEDIUM
**Location:** `api/scripts/check-rules.ts:72`
```ts
if (line.includes(`rules-ignore: ${id}`)) return;
```
CLAUDE.md:171 says the hatch must come *"with a reason"*. Nothing verifies a reason follows. Nothing counts or reports existing ignores, so there is no way to notice them accumulating. And because it is a plain substring test, the token appearing inside a *string literal* (an error message, a test fixture, a doc comment being quoted) disables the rule for that line. There is also no `rules-ignore-file`, so a developer facing 30 false positives from 8.5 has no proportionate option and will reach for editing the rule instead.

### 8.11 Rules CLAUDE.md presents as enforced that `check-rules` does not implement — HIGH
CLAUDE.md:163-169 enumerates what *"`npm run check:rules` fails the build on"*. Comparing that list to the code, several **mandatory rules stated elsewhere in CLAUDE.md have no mechanical enforcement whatsoever**:

| CLAUDE.md rule | Enforced? |
|---|---|
| *"Every route touching company or driver data declares its auth preHandler"* | **No rule exists.** The single most security-critical rule in the file. |
| *"Tenant scoping is the law — every read filters by `companyId`, every write includes `companyId` in the `where`"* | **No rule exists.** `no-client-tenant` checks where the value comes *from*; nothing checks that queries *use* it. |
| *"One status string registry"* — no magic strings in handlers | **No rule exists.** And there is no registry file. |
| *"Never comment out code"* | No rule exists. |
| The privacy boundary (driver-private fields never in company-facing output) | No rule exists. |

The tenant-scoping gap compounds with `no-prisma-in-routes`: that rule pushes all database access out of `src/routes/` and into services — and **no rule audits services at all**. The enforcement perimeter has been drawn around the one directory the queries are being deliberately moved out of. Risk is displaced, not covered.

### 8.12 Every rule is line-based, so a newline defeats all of them — MEDIUM
`scan()` (`check-rules.ts:62-76`) evaluates one line at a time, and there is no formatter in the repo (no Prettier, no `--fix` in CI) to normalise line breaks. Splitting any offending expression across two lines evades every check simultaneously. This is inherent to the approach; the mitigation is to stop relying on text matching for the rules that carry real security weight (8.1, 8.2, 8.3) and move them to AST-based eslint rules or structural tests.

### 8.13 Count mismatch across three sources — LOW
`CLAUDE.md:165-169` lists **11** enforced checks. `STATUS.md:97` claims **"check-rules (10 checks)"**. The script implements **12** (Node version, `no-any`, `no-console`, `error-envelope`, `jwt-centralised`, `zod-max`, `no-empty-catch`, `schema-nullable`, `tenant-scoped`, `no-client-tenant`, `no-prisma-in-routes`, `route-registered`). `no-prisma-in-routes` is undocumented in CLAUDE.md, and the numbering in the source comments skips it. CLAUDE.md:121 says *"Docs may be stale — code and schema win... Fix the doc in the same session"*; this is that rule being broken about the rule-checker itself.

### 8.14 `no-console`'s exemption is filename-suffix based — LOW
**Location:** `api/scripts/check-rules.ts:94` — `file => !file.endsWith("env.ts")` exempts *any* file whose name ends in `env.ts`, anywhere in the tree. `console["log"]()` and `process.stdout.write()` also bypass the rule regardless.

---

# 9. Config / runtime inconsistencies

### 9.1 CI cannot run: `npm ci` with no lockfile in the repository — CRITICAL (for CI)
**Location:** `.github/workflows/ci.yml:39,42`
```yaml
cache-dependency-path: api/package-lock.json
...
- name: Install
  run: npm ci --prefix api
```
I searched the whole tree: **there is no `package-lock.json` anywhere**, in `api/` or at root. `npm ci` fails hard without one. The `setup-node` cache step will also fail or warn on the missing path.

**Why it matters:** the workflow dies at its first substantive step, so *every* check downstream is theatre. STATUS.md:98 honestly records CI as 🔶 *"never run"*, which is why this has gone unnoticed — but it means the repo's entire safety net is unverified, and the first push to `main` produces a red build with a confusing error. A missing lockfile is also a supply-chain issue in its own right: nothing pins transitive dependency versions.

### 9.2 CI never runs eslint — HIGH
**Location:** `.github/workflows/ci.yml:44-57` vs `package.json:11`
Root `check` is `typecheck && lint && check:rules && validate:schema && knip && test`. CI runs typecheck, check:rules, knip, db:push, test. **`lint` and `validate:schema` are both absent.**

**Why it matters:** `eslint.config.js:26-37` describes its rules as catching *"the most likely production bug class here, and tsc catches neither of these"* — `no-floating-promises`, `no-misused-promises`, `@typescript-eslint/no-shadow` (whose comment reads *"Shadowing companyId/userId in a nested scope is exactly how a tenant leak gets written without anyone noticing"*). Plus `no-explicit-any`, which is CI's only real defence against 8.7. The rules identified as most important are the ones CI does not run. And a developer who follows the README will never run them locally either (9.3).

### 9.3 The README's setup instructions produce an environment where `npm run check` cannot run — HIGH
**Location:** `README.md:35-41` vs `CLAUDE.md:174`
README says: `cd api && cp .env.example .env && npm install && npm run db:push && npm run dev`. It never installs root dependencies. But CLAUDE.md:174 mandates *"Before saying 'done': `npm run check` (typecheck → rules → knip → tests) **from the repo root**"* — and root `check` immediately invokes `eslint` and `knip`, neither of which is installed.

**Why it matters:** the mandatory quality gate fails with a "command not found" for anyone who followed the documented setup. When the required gate is broken, it gets skipped — and then `api`'s *own* `check` script (`api/package.json:18`) looks like a reasonable substitute, except it omits both lint and knip. Two different scripts named `check` with materially different meanings is a trap in itself. CLAUDE.md's parenthetical also mis-describes the root script, which actually runs six steps including lint and validate:schema.

### 9.4 `npm start` depends on a devDependency — HIGH
**Location:** `api/package.json:8` (`"start": "tsx src/server.ts"`) vs `:41` (`tsx` under `devDependencies`)
Any production install using `npm ci --omit=dev` (or `NODE_ENV=production npm install`, the default on several PaaS providers) produces an image where `npm start` fails with `tsx: not found`.

**Why it matters:** compounded by there being **no `build` script at all** — so `tsconfig.json`'s `outDir`/`rootDir` are dead (5.8) and TypeScript is transpiled at runtime in production, meaning the deployed artifact is never type-checked as deployed and startup carries a transpile cost. Either add a real build and run compiled JS, or move `tsx` to `dependencies` deliberately and document that choice.

### 9.5 `npx knip` in CI ignores the pinned version and may not see the workspace — MEDIUM
**Location:** `.github/workflows/ci.yml:51`, `package.json:16`, `knip.json:3`
CI runs `npx knip` from the repo root, but only `npm ci --prefix api` ever ran — root `node_modules` does not exist. `npx` therefore downloads **`knip@latest`** from the registry, ignoring the `^6.14.2` pinned in the root `package.json`. A new major release of knip changes CI behaviour with no commit.

Separately, `knip.json:3-4` declares `"workspaces": { "api": ... }` while the root `package.json` has **no `workspaces` field** — this is not an npm workspace. Depending on knip's resolution, the `api` configuration block may not apply, in which case the entry/project/ignore settings silently do nothing and the check passes vacuously. The `$schema` also points at `unpkg.com/knip@latest/schema.json` — an unpinned remote reference.

### 9.6 CI runs `db:push`, but the deployment path is `migrate:deploy` with zero migrations — HIGH
**Location:** `.github/workflows/ci.yml:53-54`, `api/package.json:12-13`, `api/prisma/` (no `migrations/` directory), `STATUS.md:116`
CI validates the schema via `prisma db push`. `prisma.config.ts:13` declares `migrations: { path: "prisma/migrations" }`, and `migrate:deploy` exists — but no migration has ever been generated.

**Why it matters:** `db:push` and `migrate deploy` are not equivalent, and only the former is ever exercised. A production deploy running `migrate:deploy` against an empty migrations directory applies **nothing** and reports success, leaving a schemaless database and a service that fails on first query. This is also the last cheap moment to introduce migrations: several findings above (2.1 composite keys, 3.4 partial unique index, 2.5 case-insensitive email) are one-line additions to a *first* migration and table rewrites afterwards.

### 9.7 `.env.example`'s own comment contradicts its own value — LOW
**Location:** `api/.env.example:1-2`
```
# Local Postgres from docker-compose.yml (port 5433 so it never clashes with the TMS)
DATABASE_URL="postgresql://app:app@localhost:5544/lb_timesheet?schema=public"
```
The comment says **5433**; the URL, `docker-compose.yml:10`, `README.md:27` and `STATUS.md:20` all say **5544**. Trivial, but this is the one file every new developer copies, and CLAUDE.md:121 makes fixing doc/code contradictions a same-session obligation.

### 9.8 `eslint.config.js` sets `tsconfigRootDir` to a root with no `tsconfig.json` — LOW
**Location:** `eslint.config.js:19-21`
`projectService: true` with `tsconfigRootDir: import.meta.dirname` (repo root). There is no root `tsconfig.json` — only `api/tsconfig.json`. `projectService` should resolve each file to its nearest project, so this likely works today; but it is fragile, and the moment a `.ts` file appears at the root (a config, a script) it will be outside any project and typed-linting will error. Given 9.2, nobody would find out from CI.

### 9.9 `docker-compose.yml` has no healthcheck — LOW
**Location:** `docker-compose.yml:2-12`. `docker compose up -d` returns before Postgres accepts connections, so the README's very next command (`npm run db:push`) races the database on a cold start. CI's Postgres service *does* have a healthcheck (`ci.yml:26-31`); local dev does not.

---

# 10. Technically green but architecturally wrong

### 10.1 The first route ever written is public, unmarked, and queries Prisma from `app.ts` — HIGH
**Location:** `api/src/app.ts:16-24`
```ts
// Health — the only public route for now.
app.get("/health", async () => {
  const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
```
Every check passes. It is also the template for everything that follows, and it establishes three bad precedents at once:

- **Routes defined in `app.ts` are exempt from every routes/ rule.** `no-client-tenant` (`check-rules.ts:178`) and `no-prisma-in-routes` (`:193`) both filter on `/[/\\]routes[/\\]/`. A handler written in `app.ts` — as this one is — is outside both. And this handler *does* call Prisma directly, which is precisely what `no-prisma-in-routes` forbids; it escapes on a filename technicality while doing the exact thing the rule names. The precedent is legible: put it in `app.ts` and the rules do not apply.
- **Public is the default and it is invisible.** There is no `config: { public: true }` marker, no auth preHandler, no comment convention. `/health` genuinely should be public — but nothing distinguishes "deliberately public" from "forgot the preHandler", so the next route inherits absence-of-auth as the norm. AUTH.md:159 establishes *"Default is deny"* for membership status; the routing layer has no equivalent, and nothing (see 8.11) will ever flag a route that omits its preHandler.
- **Errors are silently swallowed** (1.6).

**Suggested direction:** move `/health` into `src/routes/health.ts` so it lives under the rules it is a template for, take the database check through a service, and introduce an explicit `public: true` route-config marker now — while there is exactly one route to mark.

### 10.2 `Shift.notes` and `ShiftSegment.notes` violate CLAUDE.md's first mandatory rule, and straddle the privacy boundary — HIGH
**Location:** `api/prisma/schema.prisma:103` and `:141`
CLAUDE.md:109-111: *"**Never invent data.** Never create a schema column that no form (or server-side derivation from form data) writes."*

No form writes `notes`. It is not in PRODUCT.md's in-scope list (lines 20-32), it is not in the specified PDF contents (lines 108-116, which end with *"**Do not invent additional operational information**"*), and STATUS.md lists no feature that produces it. Two free-text columns were created speculatively.

**Why it matters more than tidiness:** these are unlabelled free-text fields hanging off **company-scoped** models. CLAUDE.md's privacy boundary is a *legal* one (D11: two different controllers in one app). "Notes" is precisely the field a driver will type personal context into, and it sits on a row that flows into the company PDF and every company-facing query. There is nothing in the schema, the column name, or the comment that says which side of the boundary it is on — so the first person to render it has to guess, and the safe guess and the obvious guess differ. `check-rules` cannot detect invented columns, so the rule that would have prevented this is one of the unenforced ones from 8.11.

**Suggested direction:** drop both columns until a form writes them (CLAUDE.md:177 requires asking before dropping a column, so this is a question, not an action), and when they return, name them for their audience — `driverPrivateNotes` vs `companyNotes`.

### 10.3 Status values are documented in comments instead of a registry — MEDIUM
**Location:** `api/prisma/schema.prisma:30, 63, 97, 165`
```prisma
/// trial | active | past_due | cancelled
status String @default("trial")
/// draft | submitted | sent | failed
status String @default("draft")
```
Four separate string-typed state machines whose legal values exist only as doc comments. CLAUDE.md:151-153 mandates *"One status string registry — every status value comes from a const exported from one file per concept. Magic strings in route handlers are forbidden."* No such file exists, and no rule enforces it (8.11).

**Why it matters:** `eslint.config.js:31` enables `@typescript-eslint/switch-exhaustiveness-check` with the comment *"Adding a value to a status union should break every switch over it."* Prisma generates these fields as plain `string`, so exhaustiveness checking has nothing to bite on and the rule is inert. The intent is present in three places and realised in none. A typo'd `"submited"` is a valid write today.

**Suggested direction:** use Prisma `enum` (giving database-level validation *and* a real TypeScript union, which activates the eslint rule), or create the const registry the rule demands before the first status is written in code.

### 10.4 `Shift.driverName` is a defensible snapshot — but it is an alias with no stated rule — LOW
**Location:** `api/prisma/schema.prisma:89`
Denormalising the driver's name for the PDF is correct: the name printed on a submitted timesheet must not change when `User.name` is edited later. But CLAUDE.md:113-115 says *"One concept, one name... No aliases, no synonyms"*, and `driverName` / `User.name` are now two names for one concept, distinguished only by a comment. It is the right call; it needs to be recorded as a deliberate exception (DECISIONS, or a `rules-ignore`-style note) rather than left to be re-litigated or accidentally "fixed" into a join.

### 10.5 Nothing mechanically prevents the one thing CLAUDE.md is most emphatic about — MEDIUM
**Location:** `api/src/lib/env.schema.ts:8`, `api/prisma.config.ts`
CLAUDE.md's opening section (lines 8-27) is a sustained warning about the adjacent TMS repo: *"Never point a connection string, migration, or seed script at its database."* `DATABASE_URL` is validated as `z.string().min(1).max(500)` — any non-empty string. `prisma db push` against a TMS connection string is one typo, and `db:push` is a documented step in the README's normal setup flow.

**Why it matters:** this is the highest-stakes accident available in this repo — `prisma db push` against the TMS database would attempt to reshape the other product's operational tables. The mitigation is prose in a file agents are asked to read. Given how much enforcement machinery exists for lower-stakes rules, this one deserves a check: assert the database name matches an expected pattern (`lb_timesheet*`), and refuse to run destructive Prisma commands when it does not.

### 10.6 The rule set optimises for the schema and the routes, and leaves the services unguarded — HIGH
This is the structural version of 8.11 and worth stating on its own. The enforcement design says: routes may not touch Prisma (`no-prisma-in-routes`), routes may not read tenant IDs from the client (`no-client-tenant`), models must have `companyId` (`tenant-scoped`). Every one of those pushes the actual decision — *does this query filter by the right company?* — into `src/services/`, which is scanned by exactly zero rules. The perimeter is drawn around the areas the risk is being deliberately relocated out of. The next phase should either extend the rules to services (assert every `prisma.*.findMany/update/delete` call site includes `companyId` in its `where`) or accept that the tenant law is enforced by tests, and write those tests first.

---

# What is genuinely good

Not manufactured balance — these are decisions that will pay off:

- **`env.schema.ts` / `env.ts` split.** The comment explaining it (*"importing a module that may call process.exit is not testable, which is how this split came about"*) is the right instinct, and it is the best-tested code in the repo.
- **`buildApp(prisma)` takes its dependency as a parameter** rather than importing a singleton. This is what will make the integration tests of 6.2 trivial to write. Worth protecting.
- **`CompanyMembership` is modelled correctly from the first schema** — `@@unique([companyId, userId])`, `active` on the membership rather than the user, and both `[userId, active]` and `[companyId, active]` indexes. D12's central consequence is right, and it is the expensive thing to retrofit.
- **`@@unique([shiftId, sequence])`** on segments — the one place the schema does use a database constraint to enforce an invariant.
- **AUTH.md itself** is unusually good: freezing the contract before implementation, keeping `role` out of the token with the reasoning stated, and specifying the refresh grace window as a response to a concrete field failure mode. Most of §3 is about protecting this document from the surrounding tooling, not about the document.
- **`eslint.config.js` comments** explain *why* each non-default rule exists, including the tenant-shadowing rationale. The problem is that CI does not run it (9.2), not the config.
- **STATUS.md is honest.** Nothing in it overclaims — CI is marked "never run", the Session model is 🔲, migrations are noted as absent. Several findings above exist *because* STATUS.md told the truth about what is missing. The one inaccuracy is the "10 checks" count (8.13).

---

# Ranked: the five to fix before authentication is implemented

**1. `no-client-tenant` does not catch `const { companyId } = req.body` (8.1)**
AUTH.md's frozen contract names this rule as the mechanical guarantee of the entire tenant model, and it fails against the most common way the violation would be written — so the contract's central safety claim is currently false, and every route built on it inherits false confidence.

**2. CORS `origin: true, credentials: true` (1.1)**
The only live security-relevant line in the codebase is set to the maximally permissive value, with no env plumbing to change it — and it becomes exploitable the instant the first authenticated route exists, which is the next thing being built.

**3. CI cannot run, and would not run eslint if it could (9.1, 9.2)**
`npm ci` with no lockfile fails at the first step, and the workflow omits the lint rules the repo itself identifies as catching its most likely bug class — so auth will land with no working automated gate of any kind, and no lockfile means not even the dependency set is pinned.

**4. Tenant integrity is asserted by column name rather than by constraint (2.1, 2.2, 8.8)**
`ShiftSegment` and `ShiftSubmitJob` carry a `companyId` that the database never checks against their parent shift, `Shift` has no membership link at all, and `check-rules` reports all of it as compliant — this is the last cheap moment to fix it, because after the first migration it is a table rewrite on live tenant data.

**5. The `Session` model must be added to `GLOBAL_MODELS` before it is written (3.1)**
The `tenant-scoped` rule will flag AUTH.md's Session for lacking `companyId`, and the fastest way to make the build green is to add one — which silently breaks the frozen contract's requirement that a session survive company switching, converting a guard rail into the cause of the defect.