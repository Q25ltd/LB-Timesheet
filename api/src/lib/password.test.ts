/**
 * The password boundary (D23), and the two guarantees login depends on.
 *
 * `hashPassword` was already proven end to end by registration; what is new
 * here is verification, and both of its non-obvious properties:
 *
 *   1. it FAILS CLOSED on a stored hash this build cannot read, rather than
 *      throwing — because a throw becomes a 500 and a 500 is a different
 *      answer from the canonical 401, which makes the boundary an oracle;
 *   2. the unknown-account path actually SPENDS the bcrypt work, rather than
 *      being an optimisation that answers instantly and leaks, by timing,
 *      the fact that no account exists.
 *
 * Property 2 is asserted with a deliberately generous lower bound. The claim
 * is not "this takes 230 ms" — that is a machine-specific measurement — but
 * "a real cost-12 bcrypt comparison happened at all". Cost 12 is 4096 rounds
 * of Blowfish key setup; no plausible CPU completes that in under 25 ms,
 * while the skipped-verification path it guards against completes in ~0 ms.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyAgainstUnknownAccount, verifyPassword } from "./password.js";

const PASSWORD = "correct-horse-battery-staple";

/**
 * The floor that separates "bcrypt ran" from "the call returned early".
 * Measured on Node 22.13: cost-12 verification ~230 ms, no verification ~0 ms.
 */
const BCRYPT_WORK_FLOOR_MS = 25;

async function millisecondsTaken(work: () => Promise<unknown>): Promise<number> {
  const started = Date.now();
  await work();
  return Date.now() - started;
}

test("P1. a password verifies against its own hash, and not against another", async () => {
  const stored = await hashPassword(PASSWORD);

  assert.equal(await verifyPassword(PASSWORD, stored), true, "the credential that was hashed must verify");
  assert.equal(await verifyPassword(`${PASSWORD}x`, stored), false, "a different credential must not");
  assert.equal(await verifyPassword(PASSWORD.slice(0, -1), stored), false, "nor a prefix of it");
});

test("P2. whitespace is part of the credential — verification does not trim either side", async () => {
  // The counterpart to `PasswordPolicy` deliberately not being `.trim()`ed.
  // If either end of this ever started trimming, a password chosen with a
  // leading space would silently stop working.
  const stored = await hashPassword(` ${PASSWORD} `);

  assert.equal(await verifyPassword(` ${PASSWORD} `, stored), true, "the credential as chosen must verify");
  assert.equal(await verifyPassword(PASSWORD, stored), false, "its trimmed form is a DIFFERENT credential");
});

test("P3. a stored hash this build cannot read fails CLOSED, and never throws", async () => {
  // Every one of these is a stored value login could meet in a corrupted or
  // migrated row. `bcryptjs.compare` returns false for most of them but
  // THROWS on an unknown salt revision ("$2z$" -> "Invalid salt revision"),
  // and an escaping throw reaches the global handler as
  // `500 {"error":"Something went wrong","code":"INTERNAL"}` — a different
  // answer from the canonical 401, and therefore an oracle for "that
  // account's stored hash is broken".
  const unreadable = [
    "",
    "not-a-hash",
    "$2a$12$tooshort",
    `$2z$99$${"x".repeat(53)}`,
    "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash",
    "null",
  ];

  for (const stored of unreadable) {
    const verified = await verifyPassword(PASSWORD, stored);
    assert.equal(verified, false, `an unreadable stored hash must answer false, not throw — ${JSON.stringify(stored)}`);
  }
});

test("P4. the unknown-account path really performs bcrypt work", async () => {
  // The whole point of the fixed dummy hash. If this ever returns instantly,
  // an unknown email is answered ~230 ms faster than a wrong password and the
  // byte-identical 401 body stops hiding anything.
  const taken = await millisecondsTaken(() => verifyAgainstUnknownAccount(PASSWORD));

  assert.ok(
    taken >= BCRYPT_WORK_FLOOR_MS,
    `the unknown-account path must spend a real cost-12 verification — took ${String(taken)} ms, which is under the ${String(BCRYPT_WORK_FLOOR_MS)} ms floor that distinguishes bcrypt from an early return`,
  );
});

test("P5. the unknown-account path costs what a real wrong-password check costs", async () => {
  // Not a constant-time claim — bcrypt is not constant time and this is not
  // a side-channel proof. The claim is that the two paths are in the same
  // order of magnitude rather than 0 ms versus 230 ms.
  const stored = await hashPassword(PASSWORD);

  const real    = await millisecondsTaken(() => verifyPassword("wrong-password", stored));
  const unknown = await millisecondsTaken(() => verifyAgainstUnknownAccount("wrong-password"));

  assert.ok(real >= BCRYPT_WORK_FLOOR_MS, `the wrong-password path must verify — took ${String(real)} ms`);
  assert.ok(
    unknown >= real / 4,
    `the unknown-account path must not be dramatically cheaper than a real check — ${String(unknown)} ms vs ${String(real)} ms`,
  );
});

test("P6. the dummy hash matches nothing, including the empty string", async () => {
  // It was derived from 32 random bytes that were discarded. Nothing can
  // match it, so it can never authenticate a request by accident.
  for (const guess of ["", " ", PASSWORD, "password", "admin"]) {
    // `verifyAgainstUnknownAccount` returns void precisely so no caller can
    // branch on it; what is asserted is that it completes without granting
    // anything, which it structurally cannot.
    await assert.doesNotReject(() => verifyAgainstUnknownAccount(guess), `verification against the dummy hash must not throw for ${JSON.stringify(guess)}`);
  }
});
