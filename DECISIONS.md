# LogisticBay Timesheets — Decisions

> Settled decisions and open questions.
> Settled = do not re-litigate. Open = do not guess; ask the user.
> Last updated: 2026-09-10

---

## ✅ Settled

### D1 — Separate product, separate everything (2026-08-25)
Timesheets and the LogisticBay TMS share the **brand only**. Separate repo,
frontend, backend/API, database, authentication, deployment, environment config,
migrations and billing. No shared Company/Driver/Vehicle/Job/Run models, no
shared database, no shared package.

*Why:* the TMS is complex and multi-tenant; Timesheets is deliberately tiny.
Shared code or schema would drift toward shared auth assumptions and shared
migrations, and one product's bug would reach the other's operational data.
Separation also keeps Timesheets cheap to host and independently sellable.

### D2 — Authentication fully separate (2026-08-25)
Timesheets has its own user table, own login, own sessions, own secret. Zero
shared identity with the TMS. Considered and rejected for now: shared central
LogisticBay SSO, and shared company records.

*Why:* unifying auth later is straightforward; untangling prematurely shared auth
is not. **Revisit when:** both products are stable AND there is real customer
demand to log into both with one account.

### D3 — Domain layout (2026-08-25)
- `logisticbay.com` — marketing site; the **only** shared surface
- `timesheets.logisticbay.com` — this product
- `timesheets-api.logisticbay.com` — this product's API
- `app.logisticbay.com` / `api.logisticbay.com` — the TMS

The marketing site is **dumb**: no login, no auth, no API calls — it links out,
and each product owns its own login page. It may be a cheap static site.

Also shared, unavoidably: the DNS zone and the email sending domain (SPF/DKIM on
logisticbay.com, shared sending reputation). Brand assets are **copied** into
each product, not shared.

**Trap to avoid:** if auth ever moves to cookies, scope them per-subdomain —
never to `.logisticbay.com`, which would hand a Timesheets session to the TMS.
Bearer tokens in browser storage are origin-scoped and safe by default.

### D4 — Two apps, not one plan-gated app (2026-08-25)
Rejected: a single driver app that unlocks TMS features on a higher subscription
plan.

*Why:* the TMS is weeks-to-months from finished, and gating TMS features requires
the TMS to exist — Timesheets would ship when the TMS ships, killing the one
thing that makes this product worth doing. A plan-gated app also needs feature
flags everywhere and would ship TMS code to timesheets-only customers.

### D5 — Upgrading to the TMS is a commercial event, not a technical migration (2026-08-25)
Company upgrades → a TMS account is created → drivers install the TMS app.
Nothing needs migrating, because this product deliberately holds no large
historical archive. The company already has its PDFs by email plus the
re-download path (D7).

*Known casualty:* the driver's private salary history. See O3.

### D6 — Driver UX familiar by copying, not by sharing (revised 2026-08-25)
The shift/check flow starts identical to the TMS driver app because it is
**copied** from it, so a company upgrading costs its drivers no retraining on day
one.

**Nothing is shared afterwards.** No shared package, no shared design-token repo,
no shared component library, no "keep these two files identical" rule. Copying
once is not sharing: a copy can diverge freely, a dependency cannot.

*Why revised:* the first version of D6 kept design tokens and check definitions as
a shared surface with a sync obligation. Rejected — any shared surface means a
change in one product forces a change in the other, which is exactly the coupling
D1 exists to prevent.

*Trade accepted:* the two apps will drift apart visually over time, and the
"familiar on upgrade" promise weakens as they do. Judged worth it. If parity
matters again later it is re-achieved by deliberately copying again, never by
wiring the two together.

### D7 — The company can re-download past submissions (2026-08-25)
The web app keeps downloadable copies of submitted shifts, so a company that
loses the email can retrieve them. This rules out "delete immediately after
send".

**Implementation rule:** do **not** store generated PDFs. Store the shift record
and **regenerate the PDF on demand** at download time. A shift with its checks is
roughly 8–10 KB; 20 drivers × ~250 days ≈ ~50 MB/year. With photos dropped (D10)
there is no heavy artifact left at all — the store is pure rows, no object storage.

### D8 — Fork by copying, not cloning (2026-08-25)
Shift/check/PDF/email code is copied by hand from the TMS at `main`. Git history
is **not** carried over — 669 commits of TMS history would contradict the point
of a small separate product.

### D9 — Submitted records are kept (2026-08-25)
Shift records are retained rather than deleted shortly after sending, so a company
that loses the email can always retrieve the form. Storage cost is negligible: no
stored PDFs (D7) and no photos (D10) means pure rows — roughly 50 MB/year for a
20-driver company.

This supersedes the earlier "delete quickly" options A/B/C entirely. The retention
*period* and the cancellation rule remain open — see O1.

### D10 — No defect photographs in V1 (2026-08-25)
A defect is a **written description**. No camera, no upload, no image storage.

*Why:* it removes object storage as a service, a cost line and a GDPR surface —
but the bigger win is connectivity. Photo upload over poor signal is the usual
failure point for apps like this, and drivers are exactly the people sitting in a
yard with one bar. Text queues instantly and syncs later.

*Trade accepted:* a photo is real evidence in a dispute about a defect's severity.
Given that "simple" is the entire product, V1 gives that up. Easy to add later if
customers ask for it; much harder to remove later.

### D11 — Legal entity and data roles (2026-08-25)
All LogisticBay products are owned by **Q25 Ltd**, which holds the ICO
registration. Registration is **not** the same as compliance — a privacy policy,
stated lawful basis, stated retention (O1), a subject-access process and a breach
procedure are all still required.

Data-protection roles differ **within the same app**:

| Data | Controller | Q25's role |
|---|---|---|
| Timesheets, checks, defects | the customer haulage company | processor |
| Driver's private hours/pay diary | Q25 Ltd — not processed on the employer's behalf | controller |

Consequences: a data processing agreement with each customer company, and
sub-processor disclosure (email provider, hosting, database). This is also *why*
the privacy boundary in CLAUDE.md is not negotiable — merging the two datasets
changes Q25's legal position.

### D12 — A driver can work for multiple companies (2026-08-25)
Agency and casual driving is normal in UK haulage, so a driver identity is global
and holds a **membership per company** — the same shape the TMS already uses
(`CompanyMembership`). This reverses the earlier lean in O9, now closed.

Consequences — all cheap now, all expensive to retrofit:

- **Schema.** Driver ↔ membership ↔ company. A shift belongs to one company and
  one driver. Model it from the first migration even though most drivers will only
  ever hold one membership.
- **Morning flow.** The driver picks which company he is working for today — but
  the picker is shown **only when he holds more than one active membership**.
  Single-company drivers never see it and lose no taps.
- **Active/inactive is per membership**, not per driver. Company A deactivating
  him must not touch his work for Company B.
- **Check configuration and destination email are per company**, so both the
  checks he is shown and the inbox his PDF reaches follow the company selected.
- **Activation codes attach a membership.** Holding several is normal.
- **Privacy hardens.** Company A must never learn he also drives for Company B.
  Each company is a separate controller of its own shifts (D11); the private diary
  spans all of them and belongs to the driver alone.

*Product upside:* multi-company makes the private diary **more** valuable, not
less. An agency driver working three companies in a week gets one view of his
total hours and earnings — something no single employer can give him.

### D13 — Auth is tenant-scoped, session-backed, and frozen (2026-08-25)
Full contract in **AUTH.md**. Summary of what was chosen and why:

- **Tenant-scoped access tokens + sessions + refresh** (rejected: a `userId`-only
  token resolving membership per route, and a long-lived tenant token with no
  session layer). Access token carries `sub`, `companyId`, `membershipId`,
  `sessionId`, `iss`, `aud`; **TTL 15 minutes**.
- **`role` is NOT in the token.** Roles and memberships are revoked; a role claim
  is authority that outlives its revocation. The membership row is loaded every
  request anyway.
- **`iss`/`aud` set** so a TMS token can never validate here even if a secret were
  copied across — D1 enforced in the token format.
- **Refresh: opaque, hashed at rest, 90-day TTL, rotated with a 60s grace
  window.** Long TTL because drivers are offline for whole shifts and away for
  weeks; grace because strict rotation logs a driver out when signal drops
  mid-rotation.
- **The daily unlock is a local PIN/biometric**, not a server login.
- ~~**0 memberships → denied.**~~ **SUPERSEDED by D21 (2026-09-10).** A
  zero-membership driver now authenticates with an **identity token** that
  carries no tenant authority. **1 → auto-selected. 2+ → list, then an explicit
  server-validated switch** — both unchanged. The clause "there is no unscoped
  token in this system" is superseded in its wording only; the guarantee it
  protected is restated and strengthened by D21: *no token may reach tenant
  data without naming and validating a real membership.*
- **A deactivated membership keeps limited authority**: it can read and submit an
  already-open shift, but start nothing new. Default is deny; routes opt in.
- **Company switching is refused while a draft shift is open.**

Honest note: because membership is revalidated on every request, the token's
`companyId` does not save a database read. What it buys is that tenant selection
cannot come from the client, a stolen token is useless against another tenant,
and there is a claim to validate the row against.

### D14 — The API is not serverless; it deploys to Railway (2026-08-25)
**API → Railway. Web → Vercel** (root directory scoped to `web/`, never the repo
root). Vercel auto-detects `api/` as a Fastify project and will offer to import
it — **decline, every time.**

*Why this is not a preference:* submission delivery depends on a **long-running
worker** that polls the `ShiftSubmitJob` outbox on a loop and holds a Postgres
advisory lock. Serverless functions are short-lived and have no process to run
that loop, so submitted timesheets would sit in the outbox and no PDF would ever
reach a customer.

This is not hypothetical. The TMS lost PDFs on redeploy because submit did the
work inline; the outbox exists because of that incident. Deploying this API to a
serverless platform reintroduces the same failure in a form no retry can fix.

Also relevant: persistent Postgres connections, and the advisory lock that stops
two instances double-processing the same job.

### D15 — A Shift is owned by a CompanyMembership; one open shift per user (2026-08-30)
Chosen: membership is the authority, with `companyId`/`userId` retained as
denormalised fields that the **database** forces to agree with it. One composite
foreign key — `(membershipId, companyId, userId)` referencing the membership's
`@@unique([id, companyId, userId])` — carries all three guarantees: the
membership exists, it belongs to this user, and it belongs to this company. A
shift row cannot contradict the relationship that authorised it.

Rejected: `userId + companyId` only (structurally valid rows with no authorising
relationship — everything AUTH.md hangs off deactivation and switching would
need application checks); `membershipId` alone (loses efficient tenant querying
and the child composite FKs that key on companyId).

Deletion of a membership carrying history is `Restrict`ed — history cannot be
orphaned by an admin action.

**Shift lifecycle is now an enum**: `draft | active | finishing` are OPEN;
`submitted | voided` are CLOSED. Email delivery state lives on `ShiftSubmitJob`,
never on the shift.

**One open shift per user, across all companies** — a driver has one body; even
with several memberships he cannot be on shift for two companies at once, and
AUTH.md's "no switch while a shift is open" needs at most one open shift to
reason about. Needs a PARTIAL unique index, which Prisma cannot express: the SQL
lives in `api/prisma/invariants.sql` and must be appended to the first migration
by hand. **Until that migration exists this invariant is design intent, not
enforcement.**

### D16 — Static rules are guardrails; the database and repository are the guarantee (2026-08-30)
Three adversarial reviews independently showed regex rules cannot prove tenant
isolation (aliasing, casts and composition all evade text matching) and that
over-broad rules get silenced and die. Settled layering: the **database**
(composite FKs, partial indexes — F-02/F-09) and the **repository boundary**
(`TenantContext` + `shiftRepository` — F-01) carry the guarantee, proven by the
db and Company A/B suites; `check-rules` raises the cost of mistakes, and its
wiring is fixture-tested (F-08) so a rule cannot silently unwire. Documentation
must never again describe the static rules as the tenant security mechanism.

### D17 — Authorization failures are generic; authentication and authorization answer differently (2026-08-31)
Frozen during P1.2b. Two questions, two answers, and neither explains itself:

| | Status | `code` | `error` |
|---|---|---|---|
| Unauthenticated / invalid authentication | **401** | `UNAUTHENTICATED` | `Not authenticated` |
| Authenticated but not authorized | **403** | `FORBIDDEN` | `Not allowed` |

The 403 is **deliberately generic**. It must not reveal that a deactivated
membership caused the denial, and it must not vary by role or by which check
failed — no `MEMBERSHIP_INACTIVE`, no `ACCOUNT_INACTIVE`, no explanatory
message, no `details`.

*Why:* a denial that explains itself is an oracle for account state. AUTH.md
already forces every authentication failure to return one identical body so the
401 path cannot be probed for whether a session, membership or token was the
problem; a talkative 403 would reopen exactly that hole one level up. The cost —
a developer cannot tell from the response alone why a request was refused — is
paid in server logs, not in the API surface.

Applies to the **ordinary authorization boundary** (`authorizeTenant`). It does
**not** decide anything about AUTH.md's future limited operations for a
deactivated membership: whether those exist, and what API they take, is still
open.

### D18 — One timesheet per shift; `shiftDate` is the local start date (2026-08-31)
Owner-decided; closes **O8**.

**One timesheet = one shift.** A timesheet begins when the driver starts a shift
and stays that same timesheet until he finishes it. Crossing midnight does not
split the timesheet, does not create a second one, does not change its date, and
does not finish the shift.

- Day driver: Monday 06:00 → Monday 17:00 — one **Monday** shift.
- Night driver: Monday 18:00 → Tuesday 05:00 — one **Monday** shift.
- Night driver: Sunday 23:00 → Monday 09:00 — one **Sunday** shift.

**`Shift.shiftDate` means the local calendar date on which that shift started.**
It is computed once, at shift creation, from the start instant expressed in the
applicable **company** IANA timezone, and is immutable for the life of that
shift. `Europe/London`, local start `2026-08-31 18:00` → `shiftDate =
2026-08-31`, even though the driver finishes on `2026-09-01`.

**Instants stay UTC.** `startedAt`, and later the end instant (`endedAt` in the
schema), are real UTC instants. The company timezone decides only which local
business date a shift is filed under; it never becomes the storage form of an
instant. Elapsed shift duration is derived from instants — never by subtracting
local wall-clock representations, which double-count or lose the DST hour.

**The device is not the authority.** The phone's timezone never decides the
filing date. The company's does.

**Trampers and Night Out.** Trampers follow exactly the same
one-timesheet-per-shift rule, and a night out is not a shift boundary: the driver
still starts a shift, works, finishes it and submits it, and starting again the
following day is a second timesheet. Night Out is a **fact recorded against a
shift**, and for V1 that is all it is — record whether one occurred. It must not
alter `shiftDate`, must not hold a finished shift open, and must not introduce a
multi-day or "tramping" timesheet abstraction. No allowance, rate or payment
behaviour is decided here; monetary treatment belongs to the driver's private pay
features, designed separately and subject to CLAUDE.md's privacy boundary.

*Why:* the paper this product replaces is one sheet per shift, filled in from
book-on to book-off — a driver starting at 22:00 hands in one sheet, not two.
Filing by start date is also the only rule knowable at the moment the record is
created: a finish-date rule cannot be evaluated when the shift opens, and a
midnight split would invent a record the driver never wrote. Anchoring to the
company's timezone rather than the device's keeps one company's payroll week
consistent no matter what a phone's clock says.

*What this requires of the data model:* an authoritative **company-level IANA
timezone** must be available at shift creation, because the local date cannot be
derived without one and the device's timezone must not be substituted for it; and
`shiftDate` must be written once at creation and never updated afterwards. What
exists today, and what remains to be built for that, is STATUS.md's to state.

### D19 — Start Shift: one active shift, owned by a membership, identified by the client (2026-09-10)
Owner-decided at the Start Shift Foundation decision gate. What is built against
this is STATUS.md's to state.

**Completing Start Shift makes the shift `active`.** A driver who has booked on
is working, so the shift is created `active`, not `draft`. `draft` stays
reserved for the recoverable, not-yet-finished setup the vehicle/check branch
will need — one state, one meaning.

**An `active` shift with ZERO `ShiftSegment` rows is a valid, ordinary state.**
A driver books on at 06:00 and may not be handed a truck until 08:00. That is
one shift starting at 06:00, and until the truck arrives it has no asset
segment — not a placeholder vehicle, not `"UNKNOWN"`, not zero mileage, not an
empty segment. Vehicle type belongs to the asset flow, not to starting work.

**Both roles may start their own shift.** An active `driver` and an active
`admin` membership may each start a shift for *itself*; there is no role gate
and no RBAC. Admin confers no authority over another user or membership —
ownership comes from `TenantContext` in every case.

**One open shift, and the refusal says nothing.** A genuinely new start while
that user already has any open shift is `409 { code: "SHIFT_ALREADY_OPEN" }`,
carrying no shift id, date, start time, membership or company — and identical
whether the open shift is in this company or another. A driver may work for
several (D12); company B must not learn he is on shift for company A. The
per-user partial unique index remains the concurrency authority: the
application may read first for a better answer, but the database is what makes
a second open shift impossible.

**Offline identity is client-generated.** Start Shift is created offline, so
the same logical start may reach the API more than once — a lost response is
indistinguishable from a lost request. The client generates one stable
`clientEventId` per logical start and reuses it on every replay of that start;
the server keeps its own `Shift.id`. A client-generated primary key was
rejected: it hands the client id-space control and turns a collision into an
existence oracle for another tenant.

**Idempotency is scoped to `(membershipId, clientEventId)`** — the narrowest
trusted identity a request already carries (D15). Not global (two drivers'
ids would collide, and a client id would become a probe for another tenant's
rows) and not `(userId, …)`, which would break D12: a replay presented under a
company-B token could resolve to a company-A shift and return it.

- same membership + same event id + same `startedAt` → the existing shift, no
  duplicate, no `SHIFT_ALREADY_OPEN`;
- same membership + same event id + a DIFFERENT `startedAt` → `409 { code:
  "CLIENT_EVENT_MISMATCH" }`. Neither mutating the stored shift nor creating a
  second one is acceptable: one of the two values is wrong and the server
  cannot tell which, so it refuses instead of silently re-timing a working day.

**`GET /shifts/current` is the recovery contract** — the caller's own open
shift within the membership and company the token names, or none. It is how a
phone that crashed, restarted or lost its response finds out it is already on
shift. An open shift in another company is correctly invisible to it. It is not
a history or listing endpoint.

**Request authority stays server-derived.** The client supplies its declared
start and its event id, and nothing else: `companyId`, `userId`,
`membershipId`, `shiftDate`, `timezone`, `driverName` and `status` are refused
by strict validation rather than ignored, and every one of them is taken from
the verified token, the Company row or the User row (AUTH.md).

*Why record the refusal rather than a silent drop:* ignoring an authority field
teaches a client that it was accepted. Refusing it says plainly where tenant
identity comes from.

### D20 — Declared start and finish times are the driver's data; the app warns, the server does not block (2026-09-10)
Owner-decided 2026-09-10, superseding two policies that were tried and revoked
before they ever reached a commit: an outright ban on future start times, and a
120-second clock-skew tolerance. **Neither is current. Do not reintroduce
either as a server rule.**

**`startedAt` is official timesheet data the driver declares**, not a
measurement of when the app was opened. The backend accepts any valid
offset-aware ISO-8601 instant — past, now, or future — and persists it exactly.
There is no backdating limit, no future-time limit, no clamping to server time
and no rounding.

- 08:00, driver enters 06:00 because he forgot to open the app → accepted.
- 15:40, driver enters 15:45 because his company rounds → accepted.
- 05:57, driver enters 06:00 → accepted.

*Why:* none of those is distinguishable server-side from a mistake, and all
three are ordinary. A server that rejected them would block real drivers from
recording real work for a reason they can neither see nor fix. Rounding or
clamping would be worse still: it would rewrite payroll data and, because
idempotency compares the declared instant (D19), silently change what counts as
a replay.

**The offset is still mandatory**, and a bare wall-clock value is still
refused: the server must never guess a zone (D18). Validity of the *instant* is
enforced; its *distance from now* is not.

**The check belongs in the app, as a warning.** When a manually entered Start
**or** Finish time differs from the device's current time by more than 15
minutes in either direction, the app asks the driver to confirm — showing the
entered time itself ("Use 06:00?"), with the choice to keep it or change it. A
confirmed time is preserved exactly and the flow continues. It is a warning,
never validation, and it must never become a server-side rejection.

This applies to both ends of a shift. Finish Shift is unbuilt; the rule is
recorded now so it is not re-litigated when `endedAt` arrives.

### D21 — A driver account exists without a company; identity tokens carry no tenant authority (2026-09-10)

**Implemented for registration in Registration Increment 1** — identity
tokens, the three route postures and `/auth/me`. The login and company-switch
halves of the flow this decision describes remain unbuilt; STATUS.md owns
build state.

A legitimate `User` may hold **zero**, one, or several `CompanyMembership`
rows. A zero-membership driver must be able to register, authenticate and use
account-level functionality. This supersedes D13's "0 memberships → denied"
and AUTH.md's "0 memberships → 403, no token issued".

*Why the old rule existed, and why it is safe to change:* the intent was never
"a person must have an employer to exist" — it was "no token reaches tenant
data without a validated membership". Denying login was a blunt way to get
that. Two explicit token kinds get the same guarantee without it.

**Two token kinds, separated by JWT audience — never one polymorphic token.**

| | Identity token | Tenant access token |
|---|---|---|
| `aud` | `timesheets-identity` | `timesheets-api` (unchanged) |
| Claims | `sub`, `sessionId`, `iat`, `exp`, `iss`, `aud` | `sub`, `companyId`, `membershipId`, `sessionId`, `iat`, `exp`, `iss`, `aud` |
| Authority | the global account and its session | exactly one membership in one company |
| Yields | user + session identity | `AuthContext` → `authorizeTenant` → `TenantContext` |

`companyId` and `membershipId` remain **mandatory** in the tenant token. They
are not made optional, and no token type is allowed to sometimes carry them.

**The security invariant, restated:** *no token may reach tenant data without
naming and validating a real membership.* An identity token is structurally
unusable against a tenant route — the verifier's audience check refuses it,
the same mechanism that keeps a LogisticBay TMS token out (D1). The separation
is symmetric: a **tenant token is equally refused at an identity route**, so
one token never silently acquires a second meaning. A client that needs both
receives both.

**Three route postures**, replacing today's two. The default is unchanged and
remains the most restrictive:

| Posture | Requires | Yields |
|---|---|---|
| public | nothing | nothing |
| identity | identity token + live Session | user + session; **never** a `TenantContext` |
| tenant (**default**) | tenant token + live Session + active membership | `AuthContext` |

A route whose posture is not declared is **tenant**-protected. Omission must
never produce a public or an identity route. The runtime hook in `app.ts` is
the boundary; `check-rules` remains a guardrail only (D16).

**Registration auto-authenticates** (no "create account, now type it again"):
one operation creates the `User`, one `Session`, and the identity material,
and zero memberships is a valid successful outcome. No fake Company,
no fake CompanyMembership, no fake tenant — ever.

`requireAuth`, `authorizeTenant`, `TenantContext`, membership validation and
Start Shift authority are **unchanged** by this decision.

### D22 — Driver identity fields: first/last name, normalized email (2026-09-10)

**Implemented in Registration Increment 1.**

**`User.name` is replaced by `User.firstName` + `User.lastName`.** They are the
canonical identity fields; `name` is not retained as a second authority (one
concept, one name). Any display or full name is **derived** from the two.
`Shift.driverName` is unaffected — it stays an immutable historical snapshot
taken at Start Shift, and is never recomputed from a later name change.

**Email is the account identity, stored canonically as `trim` + `lowercase`.**
`Driver@Example.com` and `driver@example.com` are the same account. Deliberately
**not** applied: `+`-tag stripping, dot removal, or any provider-specific
transformation — those merge mailboxes that genuinely belong to different
people.

**The database carries the uniqueness guarantee**, not application code
(D16). Application-side normalization alone is insufficient: one forgotten
call site reintroduces duplicate identities into the identity system itself.

### D23 — V1 password policy and storage (2026-09-10)

**Implemented in Registration Increment 1**, for the hashing half. There is
deliberately no password *verification* helper yet: login is its caller and a
comparison function with no caller is dead code.

- **Minimum 10 characters.**
- **Maximum 72 UTF-8 BYTES** — not 72 characters. bcrypt processes at most 72
  bytes; silently accepting a longer password means silently ignoring the
  end of it. The guarantee is expressed in byte length, because 72 UTF-8 bytes
  is as few as 18 characters of ordinary accented text.
- **No mandatory uppercase, lowercase, digit or symbol.** Composition rules
  produce `Password1`, not entropy.
- **bcryptjs**, cost factor **12**. Already a declared dependency. The cost
  must be **measured** on the real Node 22.13 runtime before GREEN is
  accepted; if it is materially unsuitable, that is reported with evidence,
  not quietly lowered.

Plaintext passwords are never stored, logged, or returned. The UI states the
rule that exists ("At least 10 characters") and no implementation detail.

### D24 — Duplicate email answers 409; email ownership is unproven until verified (2026-09-10)

**The 409 is implemented in Registration Increment 1. Email verification is
deliberately still absent** — that is the decision, not an omission.

Registering an email that already exists returns **`409 EMAIL_IN_USE`** and
nothing else — no user id, no name, no account status, no membership or
company information. This is a **knowingly accepted account-enumeration
trade-off** for V1: the privacy-preserving alternative requires an email
provider and a verification lifecycle, which do not exist. Login's response
stays generic and unchanged (AUTH.md).

**Email verification is deferred, and is not a finding** — it is unbuilt
planned work, not a defect. The requirement it leaves behind is recorded here
because it will otherwise be forgotten at exactly the wrong moment:

> **A company must not gain authority over a driver account merely because an
> unverified account claimed an email address.** Email-ownership verification
> must be resolved before company invitation-by-email is accepted complete.

### D25 — Mobile client foundation and secret storage (2026-09-10)

**Implemented in Registration Increment 1.**

**React Native + Expo + TypeScript (strict).** Not a preference to revisit per
feature; changing it is an architectural decision.

**MANAGED / prebuild, confirmed 2026-09-11.** `mobile/ios/` and
`mobile/android/` are **generated build artifacts and are never committed** —
they are gitignored. The authoritative native configuration is `app.json`, the
Expo-compatible dependency set, and the Expo config plugins; `npx expo
prebuild` recreates the native projects from those on demand. Committing them
would create a second authority that silently drifts from the plugin config,
which is exactly how a plugin change stops taking effect. Migrating to a bare
workflow is an architectural decision and would amend this decision.

*Consequence worth knowing:* `expo run:ios` / `run:android` prebuild before
they build, so they will recreate those directories and may normalise
`package.json` scripts. That is expected and not a repository change to
resist.

**`mobile/tsconfig.json` is synchronised by Expo CLI**, which runs on
`expo start` / `expo run:*` and normalises the `include` array. It drops
`.expo/types/**/*.ts` and `expo-env.d.ts` because neither exists unless
`experiments.typedRoutes` is enabled. Expo's form is canonical; do not restore
those entries, and do not open a finding when the synchronisation recurs.
Investigated and accepted 2026-09-11 after it happened three times.

- **Expo SecureStore** holds the long-lived refresh secret.
- The short-lived identity / tenant access token lives **in memory only**.
- **No** authentication secret in AsyncStorage; **no** plaintext token
  persistence anywhere.
- **No SQLite yet.** It arrives with local Personal Timesheets / offline
  operational data and not before — speculative persistence infrastructure is
  forbidden (AGENT_WORKFLOW §25).
- ~~Biometric local unlocking remains future work with its own security
  contract. No biometric control ships before it exists.~~ **SUPERSEDED by
  D26 (2026-09-11)** — the contract now exists and biometric unlock ships.
  Every other bullet in this decision is unchanged.

The mobile workspace **participates in the authoritative gate**. A mobile
project CI ignores is a second-class project that rots.

---

### D26 — Biometric unlock is LOCAL authentication; the server still decides (2026-09-11)

**Supersedes exactly one clause of D25** — "no biometric control ships before
the security contract exists". This is that contract. Everything else in D25
stands: Expo SecureStore for the refresh secret, access tokens in memory, no
auth secret in AsyncStorage, no SQLite.

**The boundary, and it is the whole decision:**

> A biometric success grants PERMISSION TO USE the refresh credential this
> device already holds. It is not authentication.

```
Face ID / Touch ID / Android biometric success
  → the app may read the SecureStore refresh secret
  → POST /auth/refresh
  → the SERVER validates the Session and issues fresh material
  → only THEN is the app authenticated
```

A biometric success must NEVER set an authenticated flag, mint or fabricate an
identity or tenant token, create company authority, bypass Session validation,
or reach the app without a server round trip. `mobile/src/auth/biometrics.ts`
returns a `boolean` and holds no tokens, no session and no API client — it
cannot authenticate anyone because it has nothing to authenticate with.

**No biometric data leaves the device.** No backend endpoint, no database
column, no template, no score. The OS answers yes or no, locally.

**Biometrics are OPTIONAL and revocable.** Declining costs the driver nothing,
and email/password sign-in is always available. Cancel, failure, lockout, a
removed enrolment and missing hardware are ONE outcome: no authenticated
state, the credential kept, the password form shown. A changed fingerprint
must never revoke a valid server Session.

**The storage trade-off, stated because an auditor must not have to find it.**
The refresh secret is stored WITHOUT SecureStore's `requireAuthentication`, so
this is an **application-level gate in front of a keychain-protected
credential — NOT a hardware biometric-bound encryption key.** On a
jailbroken/rooted device whose keychain is readable, the secret can be read
without a biometric, and that is not claimed otherwise.

`requireAuthentication: true` was considered and rejected on measured grounds
from `expo-secure-store@57.0.3`'s own documentation: keys are invalidated when
biometrics change ("impossible to read its value"), so adding a fingerprint
would destroy a valid session; Android requires authentication on *all*
operations, so biometrics could not stay optional; it is unsupported in Expo
Go; and it cannot share the keychain service used by non-authenticated
operations.

**The opt-in flag** (`logisticbay.biometricUnlock`) is a non-secret
preference. Forging it grants nothing — the OS prompt, the SecureStore read
and the server's validation all remain.

**Package:** `expo-local-authentication@~57.0.3`, matched to Expo SDK 57. No
Expo or React Native upgrade.

### D27 — A personal/independent shift is local-device data; a company shift is server-backed (2026-09-12)

Owner decision. It was agreed earlier and was missing from repository
authority; recorded here so nothing has to infer it. **Nothing of it is
implemented** — see STATUS.md.

D21 already settles that a driver account exists without a company. This
settles what such a driver's own work *is*, and it is two separate things that
must not be blurred into one:

| | Company shift | Personal / independent shift |
|---|---|---|
| Backed by | the server | the device, in V1 |
| Identity | a real `CompanyMembership` | none — the driver alone |
| Company authority | the company's, and authoritative | none exists |
| Submitted to a company | yes | **never** |

**A personal shift invents no tenant.** No placeholder `Company` row, no
placeholder `CompanyMembership`, and no "personal company" standing in for the
absence of one — the same prohibition D21 states for registration, for the same
reason: a fake tenant is indistinguishable from a real one once it is in the
database, and every tenant-scoping guarantee in this product assumes a
membership means an employer.

**A personal shift is never submitted or shared with a company**, and **never
converts into a company shift automatically.** The driver cannot rename a
company either: where a company exists, its identity is the company's.

*What this decision deliberately does NOT do.* It chooses no storage
technology, no schema, no sync, no backup and no reconciliation between local
personal state and the server's one-open-shift invariant (D15) — that last one
is a real open question and will be decided when personal shifts are built,
not assumed here. D25 still governs: **no SQLite yet.**

## ❓ Open — ask the user, do not guess

### O1 — Retention period and cancellation
D9 settles *that* records are kept. Two things are still undecided:

- **How long.** "Forever" is not a policy — UK GDPR expects a stated period and a
  reason. Plausible anchors: walkaround check records are operator-licence
  relevant (industry practice tends toward ~15 months); timesheets sit near
  payroll, where ~6 years is common. Pick a number, put it in the privacy policy,
  have a solicitor confirm it.
- **What happens when a company cancels.** Deleted that day? A grace period? An
  export first? This is the question customers will actually ask.

No longer blocking the build — but blocking the privacy policy and the deletion job.

### O2 — Does the PDF keep a "loads carried" section?
The TMS shift PDF has a per-segment deliveries table (materials, collect from,
deliver to, ticket number, times, tonnes). Real paper haulage timesheets often
*do* carry load and ticket columns — so dropping it makes the PDF slightly less
faithful to the paper it replaces for some operators. But it is also the single
most likely vector for scope creep toward a TMS.

Needs a deliberate yes/no, not a side effect.

### O3 — Driver's private salary history portability
If personal data is device-local and the company upgrades to the TMS, the driver
loses months of his own diary at the worst moment. Options: portable driver
identity, an export, or explicit acceptance of the loss.

### O4 — Does the salary tracker eventually need to exist in the TMS app too?
If not, upgrading to the TMS is a **personal downgrade** for the driver — he
gains a jobs list he didn't ask for and loses the one feature that was for him.
That would make the salary tracker a third shared surface.

### O5 — Admin surface location
The company web app (registration, settings, password, destination email, driver
roster + active/inactive, subscription, download copies) is confirmed to exist.
Undecided: does it live at `timesheets.logisticbay.com` alongside the driver-
facing surface, or its own subdomain?

### O6 — Fuel / AdBlue modelling
User asked for fuel and AdBlue **per unit**. In the TMS these are shift-level
`String @default("")`, which cannot express which truck was fuelled after a
mid-day swap. Proposed: move to the segment, as a small list of filling events
(`{ type: fuel | adblue, litres, time, unitReg }`), numeric not string.

Needs confirming: one value per segment, or a list of events?

### O7 — Pricing model
Not frozen. Company-size tiers under consideration. Do not hard-code commercial
assumptions.

### O8 — Overnight shifts crossing midnight — ✅ CLOSED 2026-08-31
Resolved: **one timesheet per shift**, filed under the local calendar date the
shift **started**, computed in the company's IANA timezone and immutable
thereafter. See D18.

### O9 — Multi-company drivers — ✅ CLOSED 2026-08-25
Resolved: **supported**, and modelled from the first migration. See D12.
