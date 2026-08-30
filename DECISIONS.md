# LogisticBay Timesheets — Decisions

> Settled decisions and open questions.
> Settled = do not re-litigate. Open = do not guess; ask the user.
> Last updated: 2026-08-25

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
- **0 memberships → denied. 1 → auto-selected. 2+ → list, then an explicit
  server-validated switch.** There is no unscoped token in this system.
- **A deactivated membership keeps limited authority**: it can read and submit an
  already-open shift, but start nothing new. Default is deny; routes opt in.
- **Company switching is refused while a draft shift is open.**

Honest note: because membership is revalidated on every request, the token's
`companyId` does not save a database read. What it buys is that tenant selection
cannot come from the client, a stolen token is useless against another tenant,
and there is a claim to validate the row against.

---

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

### O8 — Overnight shifts crossing midnight
Which calendar date does a 22:00 → 06:00 shift file under? Likely dated by start
time with full timestamps on the PDF — needs confirming, affects the data model.

### O9 — Multi-company drivers — ✅ CLOSED 2026-08-25
Resolved: **supported**, and modelled from the first migration. See D12.
