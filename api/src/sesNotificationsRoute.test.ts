/**
 * The SES bounce/complaint endpoint over HTTP (D55), in a PRODUCTION process
 * with a notification topic configured. Signed messages come from
 * tests/snsSigning.ts; the network is a stand-in that records every URL the
 * app asks for — so "never fetched" is observable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOPIC, SUBSCRIBE_URL, bounceEvent, bounceNotification, fakeSns, sign, subscriptionConfirmation } from "./tests/snsSigning.js";

process.env.DATABASE_URL          = "postgresql://app:app@localhost:5544/lb_timesheet_unused";
process.env.JWT_SECRET            = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c244f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV              = "production";
process.env.WEB_ORIGIN            = "https://timesheets.logisticbay.com";
process.env.WEB_APP_URL           = "https://timesheets.logisticbay.com";
process.env.MAIL_TRANSPORT        = "ses";
process.env.CLIENT_IP_SOURCE      = "x-real-ip";
process.env.AWS_ACCESS_KEY_ID     = "AKIAFAKEFORTESTSONLY";
process.env.AWS_SECRET_ACCESS_KEY = "fake-secret-for-tests-only-never-used-to-send";
process.env.SES_NOTIFICATION_TOPIC_ARN = TOPIC;
process.env.SES_CONFIGURATION_SET = "lb-timesheets";

const { buildApp } = await import("./app.js");

/** How many times a notification reached the store — what tells "read and recorded" from "unreadable, ignored". */
let storeAttempts = 0;

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
  // Email delivery status (D56). This database has ALREADY recorded every
  // notification: its write is the unique violation a redelivery meets, and
  // the feedback id is found — so a genuine message runs the whole path to
  // the store and is answered as a duplicate. Recording for the first time
  // is proven against PostgreSQL in tests/db/emailDeliveryStatus.test.ts.
  emailSuppression: { findMany: () => Promise.resolve([]) },
  emailMessage: { create: () => Promise.reject(new Error("emailMessage.create is not part of this test")) },
  emailDeliveryEvent: { findUnique: () => Promise.resolve({ id: "already-recorded" }) },
  accountToken: {
    upsert:     () => Promise.reject(new Error("accountToken.upsert is not part of this test")),
    findUnique: () => Promise.resolve(null),
    findFirst:  () => Promise.resolve(null),
  },
  $transaction: () => {
    storeAttempts += 1;
    return Promise.reject(Object.assign(new Error("Unique constraint failed on the fields: (`feedbackId`)"), { code: "P2002" }));
  },
};

const FORBIDDEN = { error: "Not allowed", code: "FORBIDDEN" };

async function post(body: unknown, options: { wrongKey?: boolean; contentType?: string } = {}) {
  const sns = fakeSns(options);
  const app = await buildApp(db, { snsFetch: sns.fetchText });
  try {
    const res = await app.inject({
      method: "POST", url: "/webhooks/ses",
      headers: { "content-type": options.contentType ?? "text/plain; charset=UTF-8" },
      payload: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown), fetched: sns.fetched };
  } finally {
    await app.close();
  }
}

test("a genuine SES bounce from the configured topic is accepted — without any token — and reaches the store (here: already recorded)", async () => {
  const before = storeAttempts;
  const res = await post(sign(bounceNotification()));
  assert.equal(res.statusCode, 204);
  assert.equal(storeAttempts, before + 1, "positive control: the identity format reaches the store");
});

test("a genuine CONFIGURATION-SET bounce event (eventType) is accepted the same way (D58)", async () => {
  const event = bounceEvent();
  assert.match(event["Message"] ?? "", /"eventType":"Bounce"/);
  assert.doesNotMatch(event["Message"] ?? "", /notificationType/);
  const before = storeAttempts;
  const res = await post(sign(event));
  assert.equal(res.statusCode, 204);
  assert.equal(storeAttempts, before + 1, "the event was READ and reached the store — not answered 204 as unrecognised");
});

test("a configuration-set event is held to the same signature and topic checks", async () => {
  const signed = sign(bounceEvent());
  assert.equal((await post({ ...signed, Message: (signed["Message"] ?? "").replace("Permanent", "Transient") })).statusCode, 403, "tampered");
  assert.equal((await post(signed, { wrongKey: true })).statusCode, 403, "wrong key");
  assert.equal((await post(sign(bounceEvent({ TopicArn: "arn:aws:sns:us-east-1:111111111111:other" })))).statusCode, 403, "other topic");
});

test("a tampered, re-keyed or other-topic message is refused with the one generic 403", async () => {
  const signed = sign(bounceNotification());
  for (const [label, body, options] of [
    ["tampered", { ...signed, Message: (signed["Message"] ?? "").replace("Permanent", "Transient") }, {}],
    ["wrong key", signed, { wrongKey: true }],
    ["other topic", sign(bounceNotification({ TopicArn: "arn:aws:sns:us-east-1:111111111111:other" })), {}],
  ] as const) {
    const res = await post(body, options);
    assert.equal(res.statusCode, 403, label);
    assert.deepEqual(res.body, FORBIDDEN, label);
  }
});

test("a subscription is confirmed ONLY when signed, for this topic, at an SNS URL — otherwise its URL is never fetched", async () => {
  const genuine = await post(sign(subscriptionConfirmation()));
  assert.equal(genuine.statusCode, 204);
  assert.ok(genuine.fetched.includes(SUBSCRIBE_URL), "the genuine confirmation is confirmed");

  const forged = { ...sign(subscriptionConfirmation()), SubscribeURL: "https://evil.example/confirm" };
  const refused = await post(forged);
  assert.equal(refused.statusCode, 403);
  assert.ok(!refused.fetched.includes("https://evil.example/confirm"), "a forged SubscribeURL is never requested");

  const signedButOffHost = await post(sign(subscriptionConfirmation({ SubscribeURL: "https://evil.example/confirm" })));
  assert.equal(signedButOffHost.statusCode, 403, "even a signed confirmation must point at SNS");
  assert.ok(!signedButOffHost.fetched.includes("https://evil.example/confirm"));
});

test("a body that is not an SNS message is a 400, and costs no network request", async () => {
  for (const body of ["not json", JSON.stringify({ Type: "Notification" }), JSON.stringify({ hello: "world" })]) {
    const res = await post(body);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.fetched, []);
  }
});
