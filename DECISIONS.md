# LogisticBay Timesheets — Decisions

> Settled decisions and open questions.
> Settled = do not re-litigate. Open = do not guess; ask the user.
> Last updated: 2026-09-27 (Trailer foundation)

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

### D28 — The working timesheet is local first; a company is a destination, not an owner (2026-09-13)

Owner decision, taken as Start Shift implementation began. It **supersedes the
assumption** — never written down, but built into the server-first Start Shift
foundation — that pressing Start Shift immediately creates a company-owned
Shift on the server.

**The day is the driver's while it is being worked.** The phone holds the
working timesheet: start, vehicles, checks, changes, mileage, fuel, defects,
finish, corrections. None of that requires connectivity, and none of it belongs
to a company yet. This is the same local-first position D27 takes for a
personal shift, extended to every shift.

**A company is chosen as an intended DESTINATION.** At Start Shift the driver
picks Personal or one active membership. That choice:

- mints no tenant token and calls no `POST /auth/switch-company`;
- creates no server Shift and calls no `POST /shifts/start`;
- tells the company nothing and grants it nothing;
- is correctable later, so it is not an immutable ownership field.

**Personal is the default, always.** Not "unless the driver holds one
membership", not "unless they chose a company yesterday", not "unless a tenant
token happens to exist". Working for yourself costs zero taps; working for a
company costs one.

**Sharing is a separate, explicit act.** When the driver later chooses to SEND a
finished timesheet, the server validates the membership, decides the company's
destination, stores the company-facing snapshot, generates the PDF and handles
delivery. **The phone is never the authority for a company's destination
address** — it neither holds one nor displays one.

*Consequence for existing code.* `POST /shifts/start` and `GET /shifts/current`
still exist and are unchanged; they belong to the earlier server-first model and
are **deliberately not connected** to the mobile flow. How they fit this model is
an open architecture question for a later increment, not something to settle by
quietly wiring them up. STATUS.md owns what is built.

### D29 — Start Shift is minimal, a vehicle is optional, and the day is created locally (2026-09-13)

Owner decision, settled while Start Shift was built. It follows D28's
local-first position and fixes the shape of the first screen a driver uses
every morning.

**Start Shift asks four things and stops:** who the day is worked for, the
start time, whether there is a vehicle, and — only if there is — its class,
number plate and start mileage. Nothing else. No trailer, no checks, no
defects, no fuel, no AdBlue, no notes, no signature.

**A VEHICLE IS OPTIONAL, and this is a domain rule rather than a
convenience.** A driver books on at 06:00 and may not be handed a truck until
08:00. That is one working day beginning at 06:00 — not a day that has not
started, and not a day with a placeholder vehicle. So:

- a Shift may be ACTIVE with no vehicle, and that is a complete state;
- **"shift started" is NOT a synonym for "vehicle checked"**;
- checks belong to a VEHICLE, not to the shift, and are reached from the
  Active Shift flow once there is a vehicle to check;
- the answer is "Not yet", never "No" — a vehicle may still arrive today.

**The day is created LOCALLY and offline.** Pressing Start Shift writes a
local record; it makes no request, and a dead network cannot prevent a driver
beginning work. One open shift at a time, and starting is idempotent: a double
press or a relaunch mid-shift returns the day already open rather than
creating or overwriting one.

**Server synchronisation is NOT part of this.** `POST /shifts/start` still
exists, is unchanged, and remains deliberately unconnected — how the local
record reaches a company is the submission increment's problem, and D28 already
says that happens only when the driver explicitly sends it. STATUS.md owns what
is built.

### D30 — A vehicle USE is the unit of the day; class belongs to the use (2026-09-20)

Owner decision, settled while Change Vehicle / Unit was built. It fixes what a
day records when a driver hands one vehicle back and takes another.

**Each period of use is its own record, and history is immutable.** A day holds
the vehicle in use and every earlier use, each with its own start mileage, its
own checks, the moment it began and — once ended — the odometer reading the
driver entered and the moment it ended. Returning to a plate used earlier is a
**new use**, never a resumption: the earlier record, its mileages and its
completed check are never reopened, and one plate may appear several times in
one day. A use is identified by **when it began**, never by its plate.

**End mileage is entered, never inferred.** It may equal the start mileage and
may never fall below it. Nothing derives it from a later reading.

**CLASS BELONGS TO THE USE, NOT TO THE DAY.** During one shift a driver may
move between **Class 1, Class 2 and Van in any direction and any number of
times** — Class 1 → Class 2, Class 2 → Class 1, Van → Class 2, Class 1 → Van,
Class 2 → Van → Class 1. A day that has used a Class 1 is **not** locked to
Class 1 afterwards. Every use stores its own `vehicleClass`; the classes
already used constrain the next one in no way, and vehicles used earlier are
offered back whatever their class.

*Corrects:* an earlier implementation that let a Class 1 change only to another
Class 1. That rule was wrong and is gone, with tests pinning every direction.

**Terminology follows the vehicle IN USE.** Class 1 → *Current Unit / Change
Unit*; Class 2 and Van → *Current Vehicle / Change Vehicle*. It flips mid-day
as the class changes, because it is what the driver is sitting in now, not what
the day started with.

**A returned-to vehicle is asked, not assumed.** It may have been used or moved
while the driver was away, so reuse asks for a new start mileage and an
explicit *Perform vehicle checks? Yes/No*. An earlier check is never carried
across, and "No" means "not now" — there is no permanent "checks not required"
state.

**A TRAILER IS A SEPARATE ASSET, AND IS NOT CLASS 1-ONLY.** In V1 the
trailer-capable classes are **Class 1 ✅ and Class 2 ✅** — a rigid may pull a
drawbar — and **Van ❌**. A trailer is never part of the vehicle record, is
checked on its own list, and no local data model or screen may assume trailers
belong only with Class 1. The trailer's own lifecycle is D34; STATUS.md owns
what is built.

*Why:* payroll and the daily timesheet need each period of use with its own
mileages, and a walkaround check is evidence about one vehicle at one time.
Merging uses by plate, or freezing the day's class, would lose exactly the
facts the paper form captures.

### D31 — Fuel and AdBlue are EVENTS on an exact vehicle use, and a quantity may be unknown (2026-09-20, final 2026-09-27)

Owner decision, settled while Fuel + AdBlue was built and finalised with the
Active Shift layout. It fixes the LOCAL model only; see O6 for what is still
open.

**A LIST OF EVENTS, NOT A FIELD.** Each fill — diesel or AdBlue — is its own
record `{ id, type, recordedAt, litres, note }`, held on the vehicle USE it
went into (`vehicle.fills`), exactly as a check is. A use may hold any number
of them, of either type. Nothing is summed across uses: three uses of one
registration are three lists, and returning to a truck used earlier starts an
empty one (D30).

**THE QUANTITY MAY BE UNKNOWN, AND UNKNOWN IS NOT ZERO.** Yard pumps have
broken meters and bulk tanks have none; a driver genuinely knows fuel went in
and genuinely does not know how much. `litres` is therefore `number | null`,
where `null` means the amount is not known. **0 is never stored for unknown**,
no quantity is ever estimated, and no screen may show an unknown amount as
`0 L`. A total reports the litres that ARE known beside a COUNT of the fills
whose amount is not. The driver is never asked to justify not knowing.

**FUEL AND ADBLUE FROM THE CURRENT VEHICLE BELONG TO THE CURRENT USE — AND
ONLY TO IT.** They are actions inside the current vehicle / unit card on
Active Shift. There is **no vehicle or usage selector** in Add Fuel / Add
AdBlue: the screen is opened for the exact use in the card and records
against that use alone. If that use has been handed back before the driver
saves — changed for another vehicle, or ended into no vehicle (D32) — the
save **fails closed**: nothing is written, not to the ended use, not to its
replacement, and never by plate. With no vehicle in use there is no current
Fuel or AdBlue at all.

**RETROSPECTIVE CORRECTION HAPPENS ON THE ENDED USE ITSELF.** USED THIS SHIFT
lists each ended use as one compact row; the row opens THAT use — named by its
`startedAt`, never by plate, an unknown name opening nothing — and its **Edit**
may, while the overall shift is open:

- correct the **end mileage** (never below the start mileage; the distance is
  recomputed from it); and
- **add, correct and remove** that use's Fuel and AdBlue entries, with the same
  time / known-or-unknown litres / optional note as a current fill.

**IMMUTABLE IN THAT EDIT:** the use's plate, class, `startedAt`, `endedAt`,
start mileage and completed check certificate. No other use is touched — not
the next use's start mileage, and not another use of the same registration.
Moving an existing fill from one use to another is not part of this and would
be its own decision; editing a fill changes its quantity, time and note only.

**HISTORICAL DETAIL AND EDIT DO NOT NEED A VEHICLE IN USE.** A driver between
vehicles (D32) can still open an ended use and correct its end mileage or its
fills without taking another vehicle first.

*Why:* the paper timesheet records what went into which vehicle and when, and
a driver at a broken pump still has to record it. Refusing the entry, or
storing a zero, would both put a false number on a payroll document. Putting
the correction on the use it belongs to keeps the routine fill fast and the
correction unambiguous.

### D32 — A shift may run with NO vehicle; a no-vehicle period is a gap, not a record (2026-09-26)

Owner decision, settled while Fuel + AdBlue was built. It extends the Change
Unit / Change Vehicle contract of D30.

**A DRIVER MAY END A VEHICLE USE WITHOUT STARTING ANOTHER.** They hand the unit
back at 13:00 with its end mileage and then wait, load in the yard, travel as
passenger, or sit two hours until the next one is free. That time is part of the
working day. So the Change flow offers a third answer to what comes next — a
vehicle used earlier, a different vehicle, or **no vehicle** — and the third is
as ordinary as the other two.

**THE SHIFT STAYS OPEN AND `vehicle` BECOMES `null`** — the same honest state as
a day that booked on without one (D29). A shift with `vehicle: null` and a
non-empty history is a valid ACTIVE shift, and stays one across a restart. The
ended use is closed exactly as any change closes one (D30): the odometer
reading the driver entered, the moment they gave it up, and nothing else
touched — its checks and its fills stay on it.

**NOT WHILE A TRAILER IS IN USE** (D34): a trailer needs a vehicle to tow it,
so the driver hands the trailer back first; the vehicle is never ended with a
trailer still in use.

**THIS IS NOT FINISH SHIFT**, which remains a separate action. Nothing about
giving a vehicle up files, submits or ends the driver's day.

**NO RECORD IS CREATED FOR THE GAP.** The absence of a vehicle is the absence of
a use, never a use of nothing: no placeholder vehicle, no "No vehicle" history
entry, no period covering 13:00–15:00. A vehicle taken later begins a **new
use** at its own actual start, and the earlier `endedAt` is **never** rewritten
to meet it — so `old.endedAt < new.startedAt` across a gap, while a direct
vehicle-to-vehicle change may still have `old.endedAt == new.startedAt`. A
re-taken registration is a new use with its own checks and its own empty fills
(D30, D31).

**IT RECORDS NO ACTIVITY.** It is not a break, rest, POA, other work, idle time,
waiting time or any tachograph status, and no screen, field or future reader may
treat it as one. The shift itself already represents the working day.

**CURRENT FUEL AND ADBLUE NEED A VEHICLE IN USE** (D31). With none they are
unavailable — an unattached fill does not exist. The day's ENDED uses stay
openable and correctable from USED THIS SHIFT all the same (D31).

*Why:* the paper timesheet records the vehicle a driver had and the miles it
did. A driver between vehicles has neither, and the honest record is the
absence of one. Forcing them to keep a vehicle they handed back, or to finish
the shift they are still working, would both put something false on a payroll
document.

This fixes the LOCAL model. How a no-vehicle period appears in a submitted
timesheet or PDF is not decided here; STATUS.md owns what is built.

### D33 — The current vehicle card folds away when the driver's focus moves elsewhere (2026-09-27)

Owner decision, taken while the Active Shift layout was finalised. It is a
presentation rule only: nothing about it is ever stored in the day, the API or
any timesheet data, and a remount of Active Shift may open the card again.

**THE CURRENT VEHICLE / CURRENT UNIT CARD IS COLLAPSIBLE.** Collapsed, it is one
row — the plate and a chevron — and the whole row opens it. Expanded, it shows
the plate, class, start mileage, check status, Vehicle Checks, Change Vehicle /
Change Unit, Fuel and AdBlue. Pressing the plate header folds and opens it.

**IT OPENS EXPANDED WHENEVER A VEHICLE IS TAKEN** — at Active Shift's first
showing, and again for each new vehicle use — so the driver sees its details
and checks straight away.

**THE RULE: interaction INSIDE the current vehicle keeps its state; interaction
with ANOTHER Active Shift section folds it.**

- Inside, never folding: Vehicle / Unit Checks, Change Vehicle / Change Unit,
  Fuel, AdBlue.
- Another section, folding: a USED THIS SHIFT row (built — the card folds as
  the use opens, and so does the trailer card); a trailer SUCCESSFULLY added or
  changed to (built, D34 — the vehicle card folds and the new trailer opens
  expanded); Finish Shift, once it is built (today it is disabled and takes no
  press); and any future separate Active Shift section that becomes the
  driver's focus.
- Merely OPENING Add Trailer or Change Trailer and backing out folds nothing
  (owner correction, 2026-09-27): the fold follows a trailer actually taken, not
  a form visited. For the same reason the trailer card's own actions (Change
  Trailer, Fridge Diesel) fold nothing, and the vehicle's actions do not fold
  the trailer card. A trailer already in use when Active Shift opens — after a
  restart — folds nothing either.

**THE CURRENT TRAILER CARD FOLDS THE SAME WAY**, with its own state: expanded
for each new trailer use, its number header folding and opening it, collapsed
to the trailer number centred over its own one-line check status, on the same
subtle red or green ground as the vehicle card (D35). Vehicle and trailer are not an exclusive
accordion: each is opened and folded by its own header, and both may be open.

The resulting hierarchy once a trailer is taken:

```text
CURRENT UNIT
[ AB12 CDE                         > ]

CURRENT TRAILER
[ trailer details / actions          ]

USED THIS SHIFT
…
```

However it was folded, the driver can press the collapsed row at any time to
open it again. The Finish Shift increment applies this rule with its own action.

### D34 — A trailer is its own asset with its own uses; a refrigerated trailer records its fridge diesel (2026-09-27)

Owner decision, the Trailer foundation. It fixes the LOCAL model only: no
server model, submission, PDF or email exists for trailers, and none is claimed.
Trailer Checks are their own decision, D35.

**ITS OWN USES, BESIDE THE VEHICLE'S.** The day holds the trailer in use
(`trailer`) and every earlier trailer use (`previousTrailers`), never inside a
vehicle use. A trailer use is a trailer number (trimmed and upper-cased, never
format-checked — fleet numbers are as common as registrations), a type, when it
began and, if refrigerated, its fridge diesel; an ended one adds when it ended.
A use is identified by its `startedAt`, never its number. There is no trailer
mileage.

**TWO TYPES ONLY: Standard and Refrigerated.** The one distinction the app needs
is whether the trailer has a fridge unit with its own diesel. No wider trailer
taxonomy is recorded.

**WHICH VEHICLES MAY TOW ONE: Class 1 and Class 2, never a van (D30).** CURRENT
TRAILER — "No trailer" with Add Trailer, or the trailer in use — is shown behind
a Class 1 or Class 2, and nowhere else.

**THE INVARIANT: a trailer in use requires a vehicle in use that tows it**
(owner correction, 2026-09-27):

| Vehicle in use | Trailer in use | |
|---|---|---|
| Class 1 / Class 2 | yes | valid |
| Class 1 / Class 2 | none | valid |
| Van | none | valid |
| none | none | valid |
| Van | yes | **invalid** |
| none | yes | **invalid** |

It is enforced at the store, not only on screen: a trailer may only be added
or changed to behind a Class 1 or Class 2, and a saved day holding an invalid
pair fails closed rather than being guessed at.

**INDEPENDENT ASSETS.** Changing the vehicle never ends, changes or resets the
trailer; changing or ending the trailer never touches the vehicle. So the
invariant is kept by REFUSING, never by a side effect: while a trailer is in
use, Change Vehicle may not take a van and may not end into **No vehicle**. The
final press is blocked with the instruction to hand the trailer back first
("Hand back TR1234 first"), and the store refuses independently, changing
neither asset. Once the driver has chosen No trailer, both are allowed.

**CHANGE TRAILER** offers exactly two answers: a **different trailer** (its
number and type) or **No trailer** (owner correction, 2026-09-27 — trailers used
earlier are not offered back here). Changing ends the use in progress and
begins the next at the same instant; typing the number of a trailer used earlier
is a NEW use that inherits nothing — a new start, no fridge diesel, no Trailer
Check. No trailer ends the use, leaves `trailer`
`null` and the shift open, and creates no record for the gap — a trailer taken
later begins at its own later time.

**FRIDGE DIESEL** is diesel put into a refrigerated trailer's fridge unit. It is
NOT the vehicle's Fuel, never joins it, and is recorded on the exact trailer use
in the card: the same event model as D31 — one entry each, `litres` a real
positive reading or `null` when unknown (never 0), a time and an optional note,
correctable and removable. A standard trailer has none. If the trailer the form
was opened for has been changed or handed back before the save, nothing is
written — not to it, not to its replacement, never by trailer number.

**EARLIER TRAILER USES ARE SHOWN ON ACTIVE SHIFT** (owner correction,
2026-09-27): USED THIS SHIFT lists the ended vehicle uses under VEHICLES and,
directly beneath, the ended trailer uses under TRAILERS — one row per use,
newest ended first, never grouped by number, never the trailer in use. A row
shows the trailer number, its type, its hours and its own check state
("Checks completed" / "Checks not completed" — a draft is not completed); no
fridge diesel. The day's `previousTrailers` is kept in full.

**AN ENDED TRAILER USE OPENS AND IS CORRECTABLE** (owner decision,
2026-09-27). Each TRAILERS row opens THAT use — by its `startedAt`, never by
trailer number — on a Trailer Use screen in the Vehicle Use language: number,
type, start, end and duration, its Trailer Check (state, and a certificate's
defects) and, if refrigerated, its fridge diesel. **Editable:** a refrigerated
use's fridge diesel — added, corrected, removed — on the Fridge Diesel form
opened for that ended use. **Never editable:** the trailer number, its type,
`startedAt` and `endedAt`; a completed certificate is never edited in place —
a mistake in it is corrected by an appended revision (D36). A standard use
has no Edit. Every such write names the use AND that it has
ended (`usageState`), and lands on exactly one ended use: never the trailer in
use, never another use of the same number, never by number; anything else
writes nothing. A write begun on the trailer IN USE keeps its own protection —
refused once that trailer has ended.

*Why:* the paper timesheet records the trailers a driver used between which
times, as separate facts from the truck, and a fridge trailer's diesel is a
separate fill from the truck's. Folding either into the vehicle record would
lose which asset something happened to.

### D35 — Trailer Checks: each trailer use gets its own walkaround, on the Vehicle Check model (2026-09-27)

Owner decision, completing the trailer feature (D34). LOCAL only: no server
model, submission, PDF or email exists for trailer checks, and none is claimed.

**SOURCE.** Based on current DVSA guidance on GOV.UK, read 27 September 2026:
*Carry out HGV daily walkaround checks* (27 numbered checks, last updated 21
September 2023); *Guide to maintaining roadworthiness* — "The check should cover
the whole vehicle or combination… Where trailers are changed on multiple
occasions, a check should be made on each trailer being used"; and *Securing
loads on HGVs and goods vehicles* — before loading, check the load platform,
bodywork, anchorage points and twist locks where fitted, and that securing
equipment is in a usable condition. The checklist is BASED ON that guidance; it
is not DVSA-approved and nothing may say so.

**THE MAPPING.** Of DVSA's 27 checks, 1–5, 8, 9, 11 and 13–17 are the towing
vehicle's alone (cab, engine, power) and are not on the trailer list. The
trailer list takes the trailer's share of 10 (lights), 12 (body, doors, landing
legs, guards), 18 (spray suppression), 19 (tyres and wheels), 23 (load), 24
(number plate), 25 (reflectors), 26 (markings, hazard panels) and 27 (other /
specialised equipment); ALL of 20 (brake lines, trailer parking brake), 21
(electrical couplings and wiring) and 22 (coupling security); and the part of 6
that is only true with THIS trailer attached — the service brake working the
trailer brakes. Coupling is on the trailer list although half of it is on the
tractor, because taking this trailer is what makes it true or false. **Check 7
(the height marker)** also changes with the trailer and its load, but the marker
is in the cab, so it is answered on the towing vehicle's own list and not
repeated here (owner review, 2026-09-27). Every row names its DVSA check, and a
test holds that no tractor-only check appears and no trailer-relevant one is
missing. 33 rows in six sections: Coupling, Brakes / Air, Lights / Electrical,
Body / Exterior, Tyres / Wheels, Load / Equipment.

**DEFAULTS, declared per trailer type and per row, never inferred** (owner
review, 2026-09-27):

- **OK** — what every road trailer has, including landing legs (standard on the
  common semi-trailer; a drawbar driver sets N/A) and the load bed, anchor
  points and headboard (permanent structure, checked before loading).
- **N/A, optional equipment** — spray suppression (DVSA: "if required"; the
  vehicle lists are unchanged), curtains and sheets, twist locks ("where
  fitted") and specialised equipment.
- **N/A, needs a load on board** — the load secure and not moving, the straps,
  chains and nets securing it, and hazard warning panels (dangerous goods
  only). An empty trailer is normal, so these never start OK; the driver sets
  them OK once checked.

Standard: **26 OK / 7 N/A**. **Refrigerated differs in one row only** — a fridge
unit IS specialised equipment (DVSA 27), so it starts OK: **27 / 6**. DVSA
prescribes no fridge-specific walkaround item, so none is invented (no
temperature, set point, hours or service row), and Fridge Diesel is not a
check.

**THE VEHICLE CHECK MODEL, UNCHANGED.** OK / N/A / DEFECT per row; a DEFECT
needs a written description (≤500, not blank); opening writes nothing; a draft
stores only the rows that differ from their defaults; defaults are never a
check; **Complete Check** materialises every row with its section into an
immutable certificate with a stable id, `completedAt` and `completedBy` (the
signed-in driver), read afterwards from its own rows and never re-read through
a later checklist. A completed certificate is never edited; a mistake in it
is corrected by an appended revision (D36). One screen serves both,
named for what is checked — "Trailer Checks", the trailer number and type.

**ONE EXACT TRAILER USE.** A check belongs to the trailer use that opened it,
named by its `startedAt`, never by trailer number. A new trailer use — including
the same trailer taken again — starts with no check: nothing is inherited, draft
or certificate. If the trailer is changed or handed back while the check is
open, nothing is saved, not to it and not to a replacement with the same
number. A vehicle change with the same trailer in use leaves the trailer's
check exactly as it was.

**INDEPENDENT OF THE VEHICLE CHECK AND OF FRIDGE DIESEL.** Completing the unit's
check completes nothing on the trailer, and the reverse; recording fridge diesel
neither needs nor changes a trailer check.

**ON ACTIVE SHIFT** the trailer card shows its own check state (Not completed /
In progress / Completed) and **Trailer Checks** — the filled action until done,
then an outlined way back to the certificate — and folded, the trailer number
over "Checks completed" or "Checks not completed" on the same subtle green or
red ground as the vehicle card (D33).

An ENDED trailer use's check state is shown on its USED THIS SHIFT row (D34).

**A FORGOTTEN TRAILER CHECK CAN BE COMPLETED AFTERWARDS** (owner decision,
2026-09-27). From an ended use's Trailer Use screen, Trailer Checks opens THAT
use's check — its draft if one exists, otherwise a fresh one at its defaults —
and Complete Check writes the same immutable certificate as any other, attached
to that exact ended use. **`completedAt` is when the driver actually completed
it — never backdated to the trailer's hours** — and `completedBy` is the
signed-in driver. A completed certificate opens read-only, is never completed
again, and is corrected only by revision (D36); completing one use's check leaves every other use, including
another use of the same trailer, untouched.

**NOT BUILT:** repeat checks on one trailer use; defect severity; and anything
company-facing.

### D36 — A completed walkaround check is corrected by an appended revision, never edited (2026-09-27)

Owner decision. One model for Vehicle / Unit Checks and Trailer Checks. LOCAL
only: nothing company-facing exists for checks or their revisions.

**THE CERTIFICATE IS NEVER EDITED.** A completed check keeps its original rows,
`completedAt` and `completedBy` exactly as certified. A mistake found later —
Tyres marked OK that were cut — is put right with **Correct Check**, which
appends a **revision** to the check: a COMPLETE snapshot of every row (result,
section and any defect description), `revisedAt` (the device clock when the
driver confirms it — never backdated) and `revisedBy` (the signed-in driver).
Revisions are append-only; a later mistake is a later revision. **The last
revision is the effective result** — what every screen shows; the original and
every earlier revision stay readable as the correction history.

**WHAT A CORRECTION MAY CHANGE:** each row's OK / N/A / DEFECT and its defect
description, under the same rules as a completion (every row answered, every
defect described, ≤500), against the checklist version the check was
certified on. **NEVER:** the vehicle or trailer, class or trailer type, the
use's `startedAt` / `endedAt`, mileage, Fuel / AdBlue / fridge diesel, the
original completion time or completing driver. A correction that changes
nothing writes nothing; one confirmed twice is one revision.

**EXACT USE.** A correction names its use by `startedAt` and whether it is IN
USE or ENDED, and lands on that one use's check only — never another use of
the same plate or trailer number, never by plate or number. Available from a
current vehicle's or trailer's check, and from an ended use's detail.

**A FORGOTTEN VEHICLE / UNIT CHECK** on an ENDED vehicle use can be completed
from its Vehicle Use detail, exactly as a trailer's (D35): its draft resumed or
a fresh one, dated when actually completed, attributed to the signed-in driver.

**LEGACY AND FAILURE.** A completed check stored before revisions existed has
no `revisions` field: it loads as the original and zero revisions, and reading
it rewrites nothing. Malformed revision data drops the check, as any unreadable
check is dropped — it reads as not completed, never as a pass.

**ON SCREEN.** Active Shift's cards keep saying "Checks completed" — history is
not theirs to show. The check screen says **Corrected** with the time of the
latest correction and lists the history (original, then each correction with
the rows it changed); the Vehicle Use and Trailer Use details say "Completed ·
corrected".

### D37 — The open shift's file is never destroyed, never half-replaced, and no use ends before it began (2026-09-28)

Owner decision, taken before Finish Shift. It hardens the local document D28
put on the phone; it adds no store, no server and no framework.

**AN UNREADABLE DAY IS KEPT, NEVER OVERWRITTEN.** When Start Shift finds a day
file it cannot read, it first moves that file's exact bytes aside to a
recovery file (`logisticbay-open-shift.recovery-unreadable-<time>-<id>.json`)
and only then starts the new day. The name is collision-resistant, and a name
already taken is refused rather than overwritten. If the move fails, Start
Shift fails: the original stays exactly where it was, no new day is started,
and the driver sees the failure. Recovery files exist so nothing is destroyed —
the app never reads them back, and there is no recovery screen. The app deletes
none of them; how long they are kept is part of O1 and not decided here.

**EVERY WRITE IS A SAFE REPLACEMENT — NOT AN ATOMIC ONE.** The complete next
state is serialised and checked against the reader first (a state the reader
would refuse is never written), written in full to a temporary sibling
(`logisticbay-open-shift.next.json`), read back and compared, and only then
moved over the live file. A failed or short temporary write leaves the live
file untouched and is reported as a failure; a failed move is reported too,
never counted as saved. Expo's move-with-overwrite deletes the target and then
renames, on iOS and Android alike, so **one crash window remains**: between
those two steps. What survives it is the complete, verified next state in the
temporary file and no live file — the app shows no open day, never a
half-written one. The temporary file is **never read as the day**, even then,
because nothing on the disk proves that write was ever confirmed to the driver.
The next write moves any leftover temporary file aside as
`logisticbay-open-shift.recovery-unfinished-<time>-<id>.json` rather than
promoting or deleting it. Discard removes the live and temporary files — the
day being thrown away — and leaves recovery files alone.

**A FAILED SAVE IS NEVER DESCRIBED AS "NOTHING CHANGED".** Because a failed
move may already have removed the old day file, every failure of the save's
disk work is one typed error (`SafeSaveFailedError`) and the driver is told:
"The change could not be saved safely. Your shift data has been preserved. Try
again." A stale target, a refusal decided before anything was written, or a
clock that went back keeps its own message, which is true in those cases. The
screen decides by the error's type, never its text.

**NO VEHICLE OR TRAILER USE ENDS BEFORE IT BEGAN.** Change Vehicle / Unit, No
vehicle, Change Trailer and No trailer are refused when the phone's clock is
earlier than the start of the use being ended. An end at the very instant of
the start is allowed. Nothing is clamped, no clock is corrected, no other
asset is ended: the day is left exactly as it was, and the driver is told the
phone's clock is earlier than the start and to check the date and time. The
reader refuses a saved ended use whose end precedes its start — the day fails
closed, like any other malformed field.

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

### O6 — Fuel / AdBlue modelling — 🔶 PARTLY CLOSED 2026-09-20
User asked for fuel and AdBlue **per unit**. In the TMS these are shift-level
`String @default("")`, which cannot express which truck was fuelled after a
mid-day swap.

**Settled, for the LOCAL model only: a LIST OF EVENTS per vehicle use, with an
optional quantity, addable and correctable against any use of the open day**
— see D31. The original question ("one value per segment,
or a list of events?") is answered: a list. Events belong to the use, not to
the registration, and `litres` may be absent when the driver does not know it.

**Still open: how this reaches the server.** No Prisma model, migration,
segment mapping or submission format exists for fills, and D31 claims none.
Whether a segment carries the events as rows, how an unknown quantity is
represented on the wire, and what a PDF prints, are all undecided.

### O7 — Pricing model
Not frozen. Company-size tiers under consideration. Do not hard-code commercial
assumptions.

### O8 — Overnight shifts crossing midnight — ✅ CLOSED 2026-08-31
Resolved: **one timesheet per shift**, filed under the local calendar date the
shift **started**, computed in the company's IANA timezone and immutable
thereafter. See D18.

### O9 — Multi-company drivers — ✅ CLOSED 2026-08-25
Resolved: **supported**, and modelled from the first migration. See D12.
