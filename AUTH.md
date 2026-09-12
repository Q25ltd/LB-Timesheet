# Authentication & Tenant Context — Frozen Contract

> Agreed before implementation, deliberately, so that every protected route
> inherits a correct design instead of a fixable one.
>
> Changing anything in this file is an architectural decision, not a refactor.
> Stop and ask.
>
> **Status: FROZEN 2026-08-25. Amended 2026-09-10 by D21–D24, and 2026-09-11
> by D26 plus the refresh/logout/switch specifics marked below. Clarified
> 2026-09-12 by owner decision (F-27): the refresh concurrency wording, which
> an independent audit measured to be stronger than the design it describes.
> That clarification changed no behaviour.**
>
> **This file states what is DECIDED, not what is BUILT.** STATUS.md is the
> only file allowed to say which parts exist. Do not read a section here as
> evidence that it ships.

---

## The governing rule

> Authentication proves the global **User** identity. Authorization operates
> through an active **CompanyMembership**. Every **tenant** access token is
> scoped to exactly one CompanyMembership and Company. The server derives
> tenant context from the verified token and membership, and **never trusts a
> client-supplied `companyId` as authority**. Multiple memberships require an
> explicit, server-validated company-switch exchange; a single membership is
> selected automatically.
>
> **No token may reach tenant data without naming and validating a real
> membership.** A driver with no membership still has an account, and
> authenticates with an **identity token** that carries no tenant authority at
> all (D21).

A `companyId` claim inside a token does **not** by itself prevent tenant leaks.
It removes the client from the decision and gives the server something to
validate against. Prevention comes from three things together: middleware that
resolves a trusted `AuthContext`, every query using that context, and
`check-rules` failing the build when a route reaches past it.

---

## Concepts

| Concept | Is |
|---|---|
| **User** | Global human identity. One person, one row, regardless of how many companies they drive for. |
| **Company** | The tenant. Data controller for its own timesheets (DECISIONS D11). |
| **CompanyMembership** | The relationship between a User and a Company: role, active flag. Authorization hangs off this, not off User. |
| **Session** | One authenticated device/login. Survives company switching. Revoking it logs that device out. Belongs to the User; carries no company. |
| **Tenant access token** | Short-lived authority for exactly one membership, in one company. `aud: timesheets-api`. |
| **Identity token** | Short-lived authority for the ACCOUNT only — the User and their Session. No company, no membership, no role, no tenant reach. `aud: timesheets-identity` (D21). |

```
Nerijus                        Driver John          Driver Sam
 ├── Company A → admin          └── Company A → driver   (no memberships yet)
 └── Company B → driver

(Role values are the schema's lowercase `driver | admin` — canonical in
prisma/schema.prisma, per CLAUDE.md "one concept, one name".)
```

John never sees a company selector. Nerijus does. Sam has a real account, a
real session and no company at all — and that is a legitimate, fully supported
state, not a broken one (D21).

---

## Tenant access token

JWT. **TTL 15 minutes.**

```ts
{
  sub:          userId,
  companyId:    string,
  membershipId: string,
  sessionId:    string,
  iat:          number,
  exp:          number,
  iss:          "logisticbay-timesheets",
  aud:          "timesheets-api",
}
```

**`role` is deliberately absent.** Roles change, memberships get disabled, owners
remove drivers. A role baked into a token is authority that outlives its
revocation. The membership row is loaded on every request anyway, so the role is
available there, fresh, at zero extra cost. Do not add it "just for the UI" —
advisory claims become authoritative eventually.

**`iss` / `aud` are not decoration.** They make it structurally impossible for a
LogisticBay TMS token to be accepted by this API even if a secret were ever
copied between the two products. That is DECISIONS D1 enforced in the token
format itself. Since D21 they carry a second load: `aud` is what separates a
tenant token from an identity token, so the separation is enforced by the
verifier rather than by a claim the code has to remember to read.

`companyId` and `membershipId` are **mandatory here and never optional**. A
token that sometimes omits them is not a smaller tenant token — it is a
different kind, and it gets a different audience.

## Identity token (D21)

JWT. **TTL 15 minutes**, same signing secret, same issuer, **different
audience**.

*Minting note, because it cost a debugging cycle:* `@fastify/jwt` documents a
numeric `expiresIn` as **seconds** and converts to milliseconds itself. Passing
milliseconds mints a token whose declared lifetime is ~25 years, which this
API's own `exp - iat <= 900` check then refuses — a self-inflicted 401 that
looks like a verification bug. Both units are `number`, so nothing catches it
but a test on the claims.

```ts
{
  sub:       userId,
  sessionId: string,
  iat:       number,
  exp:       number,
  iss:       "logisticbay-timesheets",
  aud:       "timesheets-identity",
}
```

Account-level authority only: who the user is, and which device session they
are on. **Never** `companyId`, `membershipId` or `role` — the absence is the
design, not an omission to fill in later.

Verified through the same pipeline shape as the tenant token — signature,
algorithm, issuer, audience, required claims, `0 < exp - iat <= 900`, the
future-`iat` bound below — then the Session (present, `userId === sub`, not
revoked, not expired). It produces user + session identity and **stops there**:
no membership read, no `AuthContext`, no `TenantContext`, no route to one.

**The separation is symmetric and structural.**

- An identity token presented to a **tenant** route → `401`. The verifier's
  audience check refuses it before any claim is read, so it cannot reach
  `requireAuth`'s membership logic at all.
- A tenant token presented to an **identity** route → `401`. A more
  authoritative token is still the wrong *kind*; one token never silently
  acquires a second meaning. A client that needs both is issued both.

### Future-dated tokens (F-19)

`iat` **must not exceed server-now by more than 60 seconds.** Without this a
correctly signed token dated 24 hours ahead satisfies `0 < exp - iat <= 900`
and is honoured for a day. The 60 seconds is a clock-skew allowance between
this product's own minter and verifier, nothing more.

This is a **JWT security rule and has nothing to do with D20**, which governs
the driver's *declared* Start/Finish times. Those may legitimately be any past
or future instant and are never rejected on temporal grounds. Do not let one
rule leak into the other.

Failure is the canonical `401 { "error": "Not authenticated", "code":
"UNAUTHENTICATED" }`, like every other authentication failure. The response
never says the token was future-dated.

## Refresh token

**Opaque random string** (32 bytes, base64url) — not a JWT. Stored **hashed** in
the Session row, never in plaintext.

- **TTL 90 days.** Drivers work offline for whole shifts and go on holiday for
  weeks; a short refresh TTL means a forced re-login at exactly the wrong moment,
  which is the friction PRODUCT.md §19 exists to avoid.
- **Rotated on every use, with a grace window.** The previous token stays valid
  for a short period (60s) so a driver who loses signal mid-rotation is not
  logged out. Strict rotation without grace is a real failure mode on a lorry.
- Reuse of a token older than the grace window revokes the session.

**The rotation semantics, frozen 2026-09-11 when refresh was implemented:**

| Presented | Effect |
|---|---|
| CURRENT credential | atomic conditional rotation. New secret → current; presented digest → previous; grace deadline → now + 60s. `expiresAt` **unchanged** |
| PREVIOUS, inside grace | atomic RECOVERY rotation. A fresh current secret only — the previous digest and its deadline are left UNTOUCHED, so a further lost response can be retried with the same secret and repeated retries **cannot extend the window** |
| PREVIOUS, outside grace | REUSE → the Session is revoked → `401` |
| anything else | `401`, byte-identical to the above |

**Every write is a conditional `updateMany` whose `where` restates the state
the caller believed it was acting on**, and whose affected-row count is the
proof it won. Only ONE request may rotate a given credential as **CURRENT**:
exactly one matches that condition, and a caller acting on a superseded digest
matches no row at all.

*Clarified 2026-09-12, by owner decision, after an independent audit measured
the earlier wording to be stronger than this design.* A concurrent request is
**not** therefore refused. If the first rotation commits before the second
resolves, the second finds the presented digest in the **previous** column and
legitimately succeeds through the grace recovery above — the mechanism that
exists so a lost response is survivable, working exactly as intended. Two
simultaneous refreshes of one credential may therefore both answer `200`, and
that is correct behaviour, not a defect.

What concurrency must **never** produce: two independently usable refresh
lineages · a forked Session · a moved `expiresAt` · an incoherent row. At most
one issued secret is the live credential; any other is dead the moment it is
issued, and a caller refused by the race still recovers with the credential it
holds. This is a clarification of the recovery design already specified above —
it is not a change to it.

**Rotation NEVER moves `Session.expiresAt`.** The 90-day lifetime is the
Session's; rotating credentials inside it is not a reason to extend it.

**Reuse detection is ONE GENERATION deep, by construction.** The schema holds a
single previous digest, so a credential two or more rotations old matches
nothing and is answered as an unknown credential — it does NOT revoke the
session, because the server has no record it ever existed. This boundary is not
a general replay detector and must not be described as one.

**Lookup discipline (F-21, closed 2026-09-11).** A presented digest is resolved
by TWO unique lookups in a fixed order — current first, previous only if
current missed — never one filter across both columns. The refresh repository's
database interface declares only `findUnique` and `updateMany`, so the
ambiguous `OR` query does not typecheck.

The refresh token lives in the device's secure storage. **The driver's daily
"login" is a biometric unlock, not an email-and-password screen.** Do not
build a credentials form for every morning.

**Reconciled 2026-09-11 (D26).** Earlier wording here said "not a server round
trip", and that must NOT be read as permission to trust a local unlock. A
biometric success grants permission to USE the stored refresh credential; the
Session is then validated by `POST /auth/refresh`, and only the server's answer
authenticates anyone. What the daily unlock avoids is retyping a password — not
the round trip. A local PIN was considered and is NOT built; nothing requires
one.

---

## Registration (D21, D22, D23, D24)

```
REGISTER (firstName, lastName, email, password)   ← exactly these four
  ↓
normalise email (trim + lowercase)  ·  policy-check password  ·  hash (bcrypt)
  ↓
email already registered → 409 EMAIL_IN_USE, and nothing else about the account
  ↓
create User + one Session, atomically
  ↓
issue IDENTITY token + refresh token   ·   zero memberships   ·   zero shifts
```

The driver is **authenticated on success** — no second credential entry (D6).
Zero memberships is a successful outcome, not a degraded one. No Company, no
CompanyMembership and no tenant of any kind is created; a "personal" tenant is
never invented to make the shape uniform.

The request body is exact: any field beyond the four is **refused**, not
ignored — including `companyId`, `membershipId`, `userId`, `role` and `id`.

## Login flow

```
LOGIN (email + password)
  ↓
verify identity  → fail: 401, no detail about which half was wrong
  ↓
issue IDENTITY token + refresh  (always — the account exists regardless)
  ↓
load ACTIVE memberships

  0 memberships  → identity token only. The driver is IN. (D21, was: 403)
  1 membership   → also issue a company-scoped tenant access token
  2+ memberships → also return the membership list; NO tenant token yet
                   client picks → POST /auth/select-company → scoped tokens
```

A login that returns a membership list returns **no usable tenant access
token**. An identity token is not a weaker tenant token and is not a step
toward one: it can never reach tenant data, at any point, by any route. The
tenant boundary is unchanged — *no token reaches tenant data without naming
and validating a real membership*.

## Logout (2026-09-11)

```
POST /auth/logout   identity posture, no body
  ↓
Session.revokedAt = now   ← conditioned on revokedAt IS NULL, so the FIRST
                            revocation timestamp is the one kept
  ↓
204
```

The session revoked is the one the token names — there is no body, because a
logout that could name its own session could log out somebody else's device.
Revoking an already-revoked session is a success: the caller's goal is already
true.

**Revocation is per SESSION, never per user.** Logging out one phone leaves
another phone's session, tokens and refresh credential fully working. The same
is true of reuse-triggered revocation.

**All three credentials die together**, because `requireAuth`, `requireSession`
and the refresh boundary all read the Session row on every request: the identity
token, the tenant token and the refresh secret stop working at once.

**On the device, logout always completes locally.** The server is asked first,
while the token is still valid, but the local clear happens either way — a
driver in a yard with no signal must be signed out of the phone immediately. The
client never claims the server revocation succeeded when it did not.

## Route postures (D21)

Three, and the default is the most restrictive one.

| Posture | Token required | Result | Marked |
|---|---|---|---|
| **public** | none | no identity | explicit |
| **identity** | identity token (`aud: timesheets-identity`) | user + session; **never** a `TenantContext` | explicit |
| **tenant** | tenant token (`aud: timesheets-api`) + active membership | `AuthContext` → `authorizeTenant` | **default** |

A route that declares nothing is **tenant**-protected. An oversight must fail
closed to the strictest posture — never to public, and never to identity.
This is F-10's polarity extended, not replaced: the runtime `onRequest` hook
in `app.ts` remains the boundary, and `check-rules` remains a guardrail that
only forces the posture to be written down (D16).

## Company switch

```
POST /auth/switch-company   { membershipId }

server confirms, in order:
  membership exists
  membership.userId === authenticated user      ← never skip
  membership.active === true
  session is valid and not revoked
  ↓
new access token scoped to that membership
same session
```

Never mint a company-scoped token because the client supplied a plausible
`companyId`. The authority is the membership row, checked against the
authenticated user.

**A switch is refused while the driver has an open shift under a DIFFERENT
membership.** One open shift at a time; "which company is this shift for" must
never be ambiguous. He finishes or discards first.

*Scope, made exact when this was implemented (2026-09-11).* The refusal is for
an open shift **outside** the membership being selected. Selecting the company
the open shift already belongs to is not ambiguous and is allowed — refusing it
would lock a driver out of their own open shift. The conflict reuses Start
Shift's `409 SHIFT_ALREADY_OPEN` verbatim and is **opaque**: it never says which
company the open shift belongs to, so company B cannot learn the driver is on
shift for company A. The existence query returns a boolean and nothing else —
it is the one sanctioned cross-tenant read, and it must never grow a sibling
that returns rows.

*This endpoint serves BOTH first selection and later switching* — one concept,
one name. Login auto-selects a single active membership without calling it, and
**login does not apply the open-shift guard**: a login is not a switch, there is
no prior tenant authority to move away from, and the database enforces one open
shift per user regardless (D15).

---

## Every TENANT-protected request

This is the **tenant** posture — the default, and the only one that yields
tenant authority. The identity posture is a different, shorter pipeline that
stops at the Session and never reaches a membership (see "Identity token").

```
JWT  (aud: timesheets-api)
 ↓ verify signature, exp, iss, aud
 ↓ load Session       → revoked or expired?     → 401
 ↓ load CompanyMembership by membershipId
 ↓ confirm membership.userId === token.sub      → mismatch: 401
 ↓ confirm membership.companyId === token.companyId
 ↓
AuthContext { userId, companyId, membershipId, sessionId, role, membershipStatus }
 ↓
route uses AuthContext.companyId — and nothing else
```

### Deactivated membership — limited authority

A membership that has been deactivated does **not** immediately erase an
unsubmitted day. The work happened; the company should still receive the record.

`AuthContext.membershipStatus` is `"active" | "inactive"`. **Default is deny:**
every route requires an active membership unless it explicitly opts in.

Permitted with an inactive membership:

- read the driver's own open shift
- update and submit that shift

Denied:

- starting a new shift
- everything else

### Client-supplied tenant identifiers

A `companyId`, `membershipId` or `userId` arriving in a request body, query or
path is **never** authority.

### `companyId` is enforced mechanically, by four rules

| Rule | Scope | Fails on |
|---|---|---|
| `no-client-tenant` | routes **and** services | reading `companyId` from `body`/`query`/`params` — member access (`req.body.companyId`), bracket access (`req.body["companyId"]`), any receiver name, and destructuring including **nested** and **multi-line** |
| `no-company-id-in-dto` | all source except the token-verification modules | a Zod schema declaring a `companyId` field. The verified access-token claims schema legitimately declares one, so the rule skips exactly the modules `jwt-centralised` confines verification to — not a directory, and not a schema name. See STATUS.md for its residual limitation. |
| `no-raw-request-past-route` | routes | handing `req`, `req.body`, `req.query` or `req.params` to anything except a schema `parse`/`safeParse` |
| `no-request-in-services` | services | touching a request object at all |

Together these close the four paths client tenant identity could take:
read it directly, alias the request first, declare it on a DTO the route parses,
or pass the whole request object onward for a service to read.

Predicates live in `api/scripts/rules/tenantPatterns.ts`; each mechanism is
independently unit-tested, so removing any one of them makes a specific test fail.

### `membershipId` and `userId` are deliberately NOT banned

They legitimately arrive in a body — `POST /auth/switch-company` takes a
`membershipId` by design. They must be **validated against the authenticated
user** server-side, never trusted. No pattern can distinguish "received and
validated" from "trusted as authority", so that guarantee rests on the contract
tests below (6, 7), not on the linter. **Do not weaken those tests.**

### The trust boundary

```
request
  → route: parse and validate into a DTO
  → auth middleware: trusted AuthContext
  → service(AuthContext, DTO)
  → repository / Prisma
```

A service never sees a request object, and a DTO never carries `companyId`.
Tenant authority enters only through `AuthContext`.

### Honest limitations

- A `rules-ignore: <id>` comment silences any rule on a line. Nothing verifies a
  reason is given, and nothing counts how many exist.
- Detection is text-based, not AST-based. Sufficiently indirect code — several
  aliases deep, or dynamic property access — will pass.
- The tenant-isolation contract tests (15–17) are what actually **prove**
  isolation. The rules raise the cost of the mistake; they do not replace the
  tests.

## Contract tests — write these before the implementation

Login and selection:

1. valid credentials, 0 active memberships → **identity token, no tenant
   token** (D21; was "403, no token")
2. valid credentials, 1 active membership → tokens issued, scoped to it
3. valid credentials, 2+ memberships → membership list, **no tenant access token**
4. wrong password → 401, response identical in shape to unknown-email
5. inactive membership is not offered in the list

Switching:

6. switch to a membership belonging to another user → 403
7. switch to an inactive membership → 403
8. switch to a valid own membership → new token, same sessionId
9. switch while a draft shift is open → 409

Token validity:

10. expired access token → 401
11. token with wrong `iss` or `aud` → 401
12. token whose session has been revoked → 401
13. token whose membership was deleted → 401
14. token signed with a different secret → 401

Tenant isolation:

15. token scoped to Company A cannot read Company B's shifts
16. `companyId` in a request body is ignored — the response is scoped to the token
17. a driver with memberships in A and B, holding an A-scoped token, sees only A

Refresh:

18. valid refresh → new access token and a rotated refresh token
19. the previous refresh token still works inside the grace window
20. the previous refresh token fails after the grace window, and revokes the session
21. refresh for a deactivated membership → limited-authority token, not a full one

Deactivated membership:

22. can read own open shift
23. can submit own open shift
24. cannot start a new shift
25. cannot read anything else

Registration (D21–D24):

26. exactly four fields accepted; any fifth — `companyId`, `membershipId`,
    `userId`, `role`, `id` — is **refused**, not ignored
27. password under 10 characters → 400; over 72 UTF-8 **bytes** → 400, proven
    with a multibyte string whose byte length exceeds its character count
28. email is stored `trim`+`lowercase`, and the DATABASE refuses a second
    account differing only in case
29. duplicate email → `409 EMAIL_IN_USE`, disclosing nothing else
30. success → one User, one Session, **zero** memberships, **zero** shifts,
    and an authenticated client
31. no password plaintext and no refresh-token hash appears in any response

Identity token (D21):

32. an identity token carries `sub` and `sessionId` and **no** `companyId`,
    `membershipId` or `role`
33. an identity token presented to a tenant route (`GET /shifts/current`) →
    `401`, and never reaches Start Shift authority
34. a tenant token presented to an identity route → `401`
35. identity authentication requires `session.userId === sub`, an unrevoked
    session and an unexpired one — each failing generically
36. `iat` more than 60 seconds in the future → `401`, for both token kinds (F-19)
