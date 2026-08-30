# LogisticBay Timesheets — Agent Instructions

> Read this file first, every session, no exceptions.
> Last updated: 2026-08-25

---

## ⚠️ WHICH PROJECT AM I IN?

**You are in LogisticBay TIMESHEETS.** Repo root: `~/LB-Timesheet`

This is **NOT** the LogisticBay TMS. The TMS is a **separate product**, in a
**separate repo** (`~/timesheet-app` — the folder name is historical and
misleading; that folder is the full TMS), with its **own database**, own auth,
own deployment and own billing.

Hard rules:

- **Never edit anything under `~/timesheet-app` from this session.** If a task
  seems to require a TMS change, STOP and ask the user.
- **Never import from the TMS.** Never add it as a dependency. Never point a
  connection string, migration, or seed script at its database.
- The TMS may be **read as a reference** — this product's shift/check/PDF code
  was forked from it. Forking means **copying by hand into this repo**, never
  linking, never sharing a package, never sharing a schema.
- Both folders are often connected at once. **Check the path before every
  write.** A path starting `~/timesheet-app` is the wrong repo.

---

## What this product is

LogisticBay Timesheets replaces the two pieces of paper a UK HGV driver fills in
every day — the **daily timesheet** and the **daily walkaround check sheet** —
with a phone app. On submit it generates a PDF and emails it to the company's
office.

**Paper form → phone → PDF → company email.** That is the whole product.

It is deliberately small, cheap to run, and adoptable by a small haulage company
with no training and no fleet-management system.

## What this product is NOT

It is **not a TMS** and must never become one. Anything involving transport
operations belongs in the separate LogisticBay TMS product.

**Never build here:** jobs · loads · customers · planning · dispatch · routing ·
GPS tracking · live driver tracking · POD · delivery management · invoicing ·
fleet utilisation · maintenance planning · vehicle scheduling · tachograph
replacement · payroll processing · operational analytics · CRM.

---

## The feature test — apply before adding ANYTHING

Ask: **does this directly**

1. replace something printed on the driver's paper daily timesheet / check sheet, **or**
2. support time submission for payroll, **or**
3. support vehicle/trailer checks and defect reporting, **or**
4. provide private personal value to the driver (their own hours/pay diary)?

**YES** → it may belong here. **NO** → it belongs in the TMS, or should not be built.

If you cannot answer "what is the user-visible change of what I just did?" in one
sentence — stop.

---

## The core documents

| Question you have | Go to |
|---|---|
| What is this product, what is in and out of scope? | **PRODUCT.md** |
| What is actually built right now? | **STATUS.md** ← check before proposing anything |
| What was decided, and what is still open? | **DECISIONS.md** |
| How do auth, tokens and tenant scoping work? | **AUTH.md** ← frozen contract, changing it is an architectural decision |
| What happened in previous sessions? | **DEVLOG.md** |

**Never assume what exists. Always check STATUS.md and the actual code first.**

---

## Session start — mandatory checklist

1. **Read STATUS.md** — state what is ✅ / 🔶 / 🔲 in the area being worked on.
2. **Read DEVLOG.md top entry** — state what was last done and what was left open.
3. **Check DECISIONS.md** — do not re-litigate settled decisions; do not guess at open ones.
4. **State what you will do** and which docs you will update afterwards.

## Session end — mandatory checklist

Do this automatically, before saying "done":

1. **Update STATUS.md** — move items between 🔲 / 🔶 / ✅.
2. **Add a DEVLOG.md entry** — what was built, what was decided, what is deferred.
3. **If a decision was made or an open question emerged** — update DECISIONS.md.

---

## Mandatory rules

These are carried over from the TMS, where each one was earned by a real bug.
They are shorter here because this product is smaller — do not let them grow
back into the TMS's ruleset.

### Never invent data
Never create a schema column that no form (or server-side derivation from form
data) writes. Before reading `x.field` in any logic, confirm something writes it.
If nothing does, report **unknown** — never assume, default, or fabricate.

### One concept, one name
Before naming a field, state, variable or JSON key, check whether the concept
already exists in the schema. No aliases, no synonyms.

### Current state lives in STATUS.md only
Sentences like "not yet implemented" or "X does not exist" rot silently. Only
STATUS.md may describe what is built. Other docs point to it.

### Docs may be stale — code and schema win
If a doc contradicts the code, the doc is wrong. Fix the doc in the same session
and note it in DEVLOG. Never "fix" code to match a stale doc.

### Nullable fields
Optional strings are `String?` in the schema — never `String @default("")`.
Write path: `body.field?.trim() || null`.
(The TMS's shift models got this wrong; this repo does not inherit that.)

### No `any`, no unvalidated casts
`any` is forbidden. `as Type` only immediately after a Zod parse, a `typeof`
narrow, or an `instanceof` check. Use `unknown` and narrow it. No silent
`.catch(() => {})`.

### Every Zod string has `.max()`
Free text caps at 4000, references and codes at 64, names at 200, emails at 320,
postcodes at 16, vehicle registrations at 16. User-visible strings also `.trim()`.

### One error envelope
All API errors use `{ error: string, code?: string, details?: unknown }` via
shared helpers. No inline `reply.status(4xx).send({ error: "..." })`.

### Auth lives in middleware only
No `jwt.verify` outside the auth middleware / token helpers. Every route touching
company or driver data declares its auth preHandler.

### Tenant scoping is the law
Every read filters by `companyId` from the JWT. Every write includes `companyId`
in the `where` clause. A `companyId` in a request body is never trusted.

### One status string registry
Every status value comes from a const exported from one file per concept. Magic
strings in route handlers are forbidden.

### Register what you create
Every new route file is imported and registered in the app in the same commit.
Every new page is added to the router. Files written and never imported are
deleted on sight.

### Never comment out code
Delete it. Git history is the archive.

### Guardrails vs guarantees — do not confuse them
Tenant safety rests on three layers, strongest first:

1. **The database** — composite FKs bind every Shift to the membership that
   authorised it and every child to its parent's company; a partial unique
   index enforces one open shift per user. Proven by `src/tests/db/`.
2. **The repository boundary** — tenant models are reached only through
   `src/repositories/` with a nominal `TenantContext` (constructed solely by
   `TenantContext.trust()`), so an ID-only query is not expressible there.
   Proven by the Company A/B tests in `repositoryTenantBoundary.test.ts`.
3. **check-rules** — text-based guardrails that raise the cost of mistakes.
   They are NOT the security guarantee: sufficiently indirect code evades
   them. Their own wiring is fixture-tested (`scripts/rules/engine.test.ts`),
   so an unwired rule turns the suite red.

`npm run check:rules` fails the build on: Node older than 22.13 · `any` ·
`console.*` in src · inline error sends · `jwt.verify` outside the auth helpers ·
an unbounded `z.string()` · an empty `.catch(() => {})` · `String @default("")` in
the schema · a tenant model with no `companyId` · a route file never registered in
`app.ts`.

Plus four rules protecting the tenant boundary (all detailed in AUTH.md):

| Rule | Fails on |
|---|---|
| `no-client-tenant` | a **route or service** reading `companyId` from request input — member access, bracket access, or destructuring (including nested and multi-line) |
| `no-company-id-in-dto` | a Zod schema declaring a `companyId` field |
| `no-raw-request-past-route` | a route handing `req` / `req.body` / `req.query` / `req.params` to anything other than a schema `parse` |
| `no-request-in-services` | a service touching a request object at all |

**Only `companyId` is banned.** `membershipId` and `userId` legitimately arrive in
a body — `POST /auth/switch-company` takes a `membershipId` by design. They must
be validated against the authenticated user server-side; that rests on tests, not
on the linter.

Escape hatch: `// rules-ignore: <id>` on the line, **with a reason**. Reaching for
it often means the rule is wrong — change the rule, don't paper over it.

Before saying "done": `npm run check` from the repo root — generate, typecheck,
eslint, check-rules, prisma validate, knip, unit tests, then the db stage, which
builds a clean database from the real migrations and runs the integrity and
Company A/B suites. One command; CI runs the same one.

Never `npm audit fix --force` — see DEVLOG 2026-08-25.

### When in doubt, stop and ask
Before dropping a column, renaming a status string, changing a default,
invalidating sessions, or changing the data-retention behaviour — stop and ask.

---

## Privacy boundary — do not cross without explicit approval

The driver's optional personal data (driving time, other work, POA, distance,
pay rates, earnings) is **private to the driver** and must **never** appear in
the company PDF or any company-facing screen or export, unless the user
explicitly authorises it.

The company sees: start/finish times, assets used, checks, defects, declaration.
Nothing else.

This is not merely a product preference — it is a **legal boundary**. For
timesheet and check data the customer company is the data **controller** and
Q25 Ltd is the **processor**. For the driver's private diary Q25 Ltd is likely
the **controller**, because that data is not processed on the employer's behalf.
Two roles, one app. Merging the two datasets changes Q25's legal position — it is
never a silent refactor.

A driver may work for **several companies**. Company A must never learn that he
also drives for Company B — not via a screen, an export, a PDF, or an API
response. Every company-facing query filters by the membership the request is
scoped to, never by driver alone.

## Retention

Submitted shift records are **kept**, so a company can re-download a form it lost
(D9). This is affordable because there are no stored PDFs and no photos.

Still open (O1): the exact retention period, and what happens to a company's
records when they cancel. Do not implement, change, or "tidy up"
retention/deletion behaviour beyond what D9 states without explicit approval.

---

## Fork lineage

The shift, check, PDF and email code originates from the LogisticBay TMS
(`~/timesheet-app`, forked at `main` on 2026-08-25). It was **copied**, not
linked. There is no shared package, no shared schema and no shared database, and
there must never be one. Git history was deliberately not carried over.
