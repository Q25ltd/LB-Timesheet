/**
 * F-22 — a TenantContext is immutable once constructed.
 *
 * `readonly` on the fields is a COMPILE-TIME promise only. At runtime the
 * instance was an ordinary mutable object, so anything holding a context —
 * a service, a repository helper, a logger decorator — could repoint the
 * company it was scoped to and every subsequent query would follow. The
 * authority object has to be as hard to alter as it is to obtain.
 *
 * WRITTEN RED: before `Object.freeze(this)` these assertions fail, because
 * `Reflect.set` succeeds and the company actually changes.
 *
 * The mutations below are expressed with `Reflect` and `Object.assign` rather
 * than a cast on purpose: CLAUDE.md forbids unvalidated `as` casts, and these
 * reproduce hostile code without needing one.
 *
 * HONEST LIMIT, not asserted here because asserting a weakness would break the
 * day someone closed it: freezing stops MUTATION, not FORGERY. A deliberate
 * `as unknown as TenantContext` still manufactures a structurally-valid
 * authority object, and no TypeScript construct can prevent that. That is
 * D16's layering — the guarantee is the repository boundary and the database
 * composite keys, proven in src/tests/db/, not this class.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TenantContext } from "./tenantContext.js";

const COMPANY       = "comp_cmth00000000000000000001";
const USER          = "user_cmth00000000000000000001";
const MEMBERSHIP    = "memb_cmth00000000000000000001";
const OTHER_COMPANY = "comp_cmth00000000000000000002";

function context(): TenantContext {
  return TenantContext.trust({ companyId: COMPANY, userId: USER, membershipId: MEMBERSHIP });
}

test("1. every authority field refuses to be repointed after construction", () => {
  const ctx = context();

  // Asserted FIRST: if trust() did not carry these through, "unchanged below"
  // would be vacuously true and this test would prove nothing.
  assert.equal(ctx.companyId,    COMPANY,    "positive control: the context carries the company it was trusted with");
  assert.equal(ctx.userId,       USER,       "positive control: and the user");
  assert.equal(ctx.membershipId, MEMBERSHIP, "positive control: and the membership (D15)");

  assert.equal(
    Reflect.set(ctx, "companyId", OTHER_COMPANY), false,
    "repointing the company must fail — this is the one that turns a scoped query into a cross-tenant read",
  );
  assert.equal(ctx.companyId, COMPANY, "and the company must be unchanged after the attempt");

  assert.equal(Reflect.set(ctx, "userId", "user_cmth00000000000000000002"), false, "the user must not be repointable");
  assert.equal(ctx.userId, USER);

  assert.equal(
    Reflect.set(ctx, "membershipId", "memb_cmth00000000000000000002"), false,
    "membershipId is what separates two drivers inside one company — repointing it widens every findById/update/delete",
  );
  assert.equal(ctx.membershipId, MEMBERSHIP);
});

test("2. a direct assignment throws rather than failing silently", () => {
  const ctx = context();
  // ESM is always strict mode, so a write to a frozen property is a TypeError
  // rather than a silent no-op. A caller attempting this gets an exception the
  // global handler masks to a 500 — loud and closed, not quietly wrong.
  assert.throws(
    () => Object.assign(ctx, { companyId: OTHER_COMPANY }),
    TypeError,
    "a silent no-op would leave the caller believing it had re-scoped the context",
  );
  assert.equal(ctx.companyId, COMPANY);
});

test("3. the authority object cannot be extended or trimmed", () => {
  const ctx = context();

  assert.equal(
    Reflect.set(ctx, "allowInactive", true), false,
    "bolting a capability onto the authority object must not be possible — a future inactive exception has to be a separate export, not a property someone adds",
  );
  assert.equal(Object.hasOwn(ctx, "allowInactive"), false);

  assert.equal(
    Reflect.defineProperty(ctx, "companyId", { value: OTHER_COMPANY }), false,
    "and defineProperty must not get around the assignment guard",
  );
  assert.equal(ctx.companyId, COMPANY);

  assert.equal(Reflect.deleteProperty(ctx, "companyId"), false, "nor may an authority field be deleted");
  assert.equal(ctx.companyId, COMPANY);

  assert.ok(Object.isFrozen(ctx), "the structural statement of all of the above");
});

test("4. freezing does not damage what the class is for", () => {
  const ctx = context();

  assert.ok(ctx instanceof TenantContext, "the nominal brand repositories rely on must survive freezing");
  assert.equal(
    ctx.describe(), `TenantContext(company=${COMPANY}, membership=${MEMBERSHIP})`,
    "prototype methods are unaffected by a frozen instance",
  );

  const other = TenantContext.trust({ companyId: OTHER_COMPANY, userId: USER, membershipId: MEMBERSHIP });
  assert.equal(other.companyId, OTHER_COMPANY, "and freezing one instance must not affect the next");
  assert.equal(ctx.companyId, COMPANY);
});
