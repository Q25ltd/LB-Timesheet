# Authentication & Tenant Context — Frozen Contract

> **Status: FROZEN 2026-08-25.** Agreed before implementation, deliberately, so
> that every protected route inherits a correct design instead of a fixable one.
>
> Changing anything in this file is an architectural decision, not a refactor.
> Stop and ask.

---

## The governing rule

> Authentication proves the global **User** identity. Authorization operates
> through an active **CompanyMembership**. Every access token is scoped to
> exactly one CompanyMembership and Company. The server derives tenant context
> from the verified token and membership, and **never trusts a client-supplied
> `companyId` as authority**. Multiple memberships require an explicit,
> server-validated company-switch exchange; a single membership is selected
> automatically.

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
| **Session** | One authenticated device/login. Survives company switching. Revoking it logs that device out. |
| **Access token** | Short-lived authority for exactly one membership, in one company. |

```
Nerijus                        Driver John
 ├── Company A → OWNER          └── Company A → DRIVER
 └── Company B → DRIVER
```

John never sees a company selector. Nerijus does.

---

## Access token

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
format itself.

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

The refresh token lives in the device's secure storage. **The driver's daily
"login" is a local PIN or biometric unlock, not a server round trip.** Do not
build an email-and-password screen for every morning.

---

## Login flow

```
LOGIN (email + password)
  ↓
verify identity  → fail: 401, no detail about which half was wrong
  ↓
load ACTIVE memberships

  0 memberships  → 403, no token issued
  1 membership   → select automatically → issue company-scoped access + refresh
  2+ memberships → return the membership list; NO access token yet
                   client picks → POST /auth/select-company → scoped tokens
```

A login that returns a membership list returns **no usable access token**. There
is no "unscoped" token in this system.

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

**A switch is refused while the driver has an open (draft) shift.** One open shift
at a time; "which company is this shift for" must never be ambiguous. He finishes
or discards first.

---

## Every protected request

```
JWT
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
path is **never** authority. Enforced mechanically: `check-rules` fails the build
if anything under `src/routes/` reads them from the request.

---

## Contract tests — write these before the implementation

Login and selection:

1. valid credentials, 0 active memberships → 403, no token
2. valid credentials, 1 active membership → tokens issued, scoped to it
3. valid credentials, 2+ memberships → membership list, **no access token**
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
