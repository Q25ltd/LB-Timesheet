/**
 * The development email link is NOT available in production — by
 * construction, not by a check at request time.
 *
 * `GET /dev/email-verification-link` hands a signed-in account the
 * verification link the DEVELOPMENT OUTBOX received. It is registered only
 * when the app's mail transport is that outbox (`MAIL_TRANSPORT=outbox`, which
 * the environment allows in development only). This process runs as
 * PRODUCTION — with SES, as production must have — and proves the route does
 * not exist: not refused, not empty, absent from the router.
 *
 * The transport rule itself is proven for every environment below, because
 * the environment is read once per process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// env.ts validates process.env at import time, so these are set BEFORE app.js
// is loaded — a PRODUCTION process.
process.env.DATABASE_URL     = "postgresql://app:app@localhost:5544/lb_timesheet_unused";
process.env.JWT_SECRET       = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c244f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV         = "production";
process.env.WEB_ORIGIN       = "https://timesheets.logisticbay.com";
process.env.WEB_APP_URL      = "https://timesheets.logisticbay.com";
process.env.MAIL_TRANSPORT        = "ses";
process.env.AWS_ACCESS_KEY_ID     = "AKIAFAKEFORTESTSONLY";
process.env.AWS_SECRET_ACCESS_KEY = "fake-secret-for-tests-only-never-used-to-send";

const { buildApp } = await import("./app.js");
const { mailTransportFor } = await import("./lib/mailer.js");

/** No database: nothing here may reach one. */
const db = {
  $queryRaw: (_query: TemplateStringsArray, ..._values: unknown[]): Promise<unknown> =>
    Promise.resolve([{ ok: 1 }]),
  session: {
    findUnique: (): Promise<null> => Promise.resolve(null),
    updateMany: () => Promise.resolve({ count: 0 }),
    create:     () => Promise.reject(new Error("session.create is not part of this test")),
  },
  companyMembership: {
    findUnique: (): Promise<null> => Promise.resolve(null),
    // Company selection's read. No case in this file selects a company.
    findFirst:  (): Promise<null> => Promise.resolve(null),
    findMany:   () => Promise.resolve([]),
  },
  // Start Shift's reads. Not exercised here — these tests never authenticate,
  // and /health is public — but AppDatabase now names them, so the stand-in
  // has to be honest about what the app is able to ask for.
  shift: {
    count:     () => Promise.resolve(0),
    create:    () => Promise.reject(new Error("shift.create is not part of this test")),
    findFirst: () => Promise.resolve(null),
  },
  company: { findUnique: () => Promise.resolve(null) },
  user: {
    findUnique: () => Promise.resolve(null),
    // Login's credential read. Declared because `AppDatabase` requires it;
    // no case in this file logs in.
    findFirst: () => Promise.resolve(null),
    // The account boundary's write (D21). It REJECTS: no case in this file
    // registers an account, so reaching it would mean the app did something
    // the test never asked for.
    create: () => Promise.reject(new Error("user.create is not part of this test")),
  },
  pendingCompanyRegistration: {
    findUnique: () => Promise.resolve(null),
    create:     () => Promise.reject(new Error("pendingCompanyRegistration.create is not part of this test")),
  },
  // Email delivery status (D56): nothing is suppressed, and nothing here sends.
  emailSuppression: { findMany: () => Promise.resolve([]) },
  emailMessage: { create: () => Promise.reject(new Error("emailMessage.create is not part of this test")) },
  emailDeliveryEvent: { findUnique: () => Promise.resolve(null) },
  accountToken: {
    upsert:     () => Promise.reject(new Error("accountToken.upsert is not part of this test")),
    findUnique: () => Promise.resolve(null),
    findFirst:  () => Promise.resolve(null),
  },
  $transaction: () => Promise.reject(new Error("$transaction is not part of this test")),
};


test("in production the development email link route is NOT REGISTERED", async () => {
  const app = await buildApp(db);
  try {
    assert.equal(app.hasRoute({ method: "GET", url: "/dev/email-verification-link" }), false, "absent from the router");
    const res = await app.inject({ method: "GET", url: "/dev/email-verification-link", headers: { authorization: "Bearer anything" } });
    assert.equal(res.statusCode, 404);
    assert.ok(!res.body.includes("token"), "and nothing about a token comes back");
  } finally {
    await app.close();
  }
});

test("with no notification topic configured, the SES notification endpoint does not exist either", async () => {
  const app = await buildApp(db);
  try {
    assert.equal(app.hasRoute({ method: "POST", url: "/webhooks/ses" }), false);
  } finally {
    await app.close();
  }
});

test("only the OUTBOX transport exposes an outbox — never SES, never disabled", () => {
  const aws = { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAFAKE", AWS_SECRET_ACCESS_KEY: "fake" };
  assert.equal(mailTransportFor({ ...aws, MAIL_TRANSPORT: "ses" }).outbox, null, "real email has no outbox to expose");
  assert.equal(mailTransportFor({ ...aws, MAIL_TRANSPORT: "disabled" }).outbox, null);
  assert.equal(typeof mailTransportFor({ ...aws, MAIL_TRANSPORT: "outbox" }).outbox, "string");
});
