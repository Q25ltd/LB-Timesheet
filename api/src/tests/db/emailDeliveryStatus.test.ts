/**
 * Email delivery status (D56), end to end against PostgreSQL:
 *
 *   a send SES accepts → recorded against the ACCOUNT it was for
 *   SES's signed notification → recorded once, as its kind
 *       hard bounce   suppresses the address
 *       transient     suppresses nothing
 *       complaint     suppresses the address, as its own reason
 *   a suppressed address is not asked again
 *   the account sees its own problem, and may correct its address
 *
 * The mailer here is a stand-in that answers an SES-style message id; SNS
 * messages are signed with the test key (tests/snsSigning.ts), and the app
 * reads that key from a stand-in network — nothing reaches AWS.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import type { MailMessage, Mailer } from "../../lib/mailer.js";
import { TOPIC, fakeSns, sign } from "../snsSigning.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the email delivery status tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;
process.env.SES_NOTIFICATION_TOPIC_ARN = TOPIC;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `email-delivery-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_403 = { error: "Not allowed", code: "FORBIDDEN" };
const UNDELIVERABLE = { error: "Email cannot be delivered to this address. Correct your email address.", code: "EMAIL_UNDELIVERABLE" };

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

/** What the stand-in SES accepted: each message with the id SES would have given it. */
const sent: { message: MailMessage; sesMessageId: string }[] = [];
const sesLike: Mailer = {
  send(message) {
    const sesMessageId = `ses-${randomUUID()}`;
    sent.push({ message, sesMessageId });
    return Promise.resolve(sesMessageId);
  },
};

interface Injected { statusCode: number; body: unknown; raw: string }

async function inject(options: { url: string; method?: "GET" | "POST"; payload?: object | string; token?: string; web?: boolean; text?: boolean }): Promise<Injected> {
  const app = await buildApp(prisma, { mailer: sesLike, snsFetch: fakeSns().fetchText });
  try {
    const headers: Record<string, string> = {};
    if (options.web === true) headers["origin"] = ORIGIN;
    if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
    if (options.text === true) headers["content-type"] = "text/plain; charset=UTF-8";
    const res = await app.inject({
      method: options.method ?? "POST", url: options.url, headers,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown), raw: res.body };
  } finally {
    await app.close();   // settles background sends
  }
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (Reflect.get(body, key) as unknown) : undefined;
}

function stringField(body: unknown, key: string): string {
  const value = field(body, key);
  assert.equal(typeof value, "string", `the response must carry \`${key}\` as a string`);
  return value as string;
}

/** A company registration through the website; answers its identity token. */
async function registerCompany(email: string): Promise<string> {
  const res = await inject({
    url: "/auth/web/register", web: true,
    payload: { companyName: `${TAG}-co`, timeZone: "Europe/Vilnius", firstName: "Ona", lastName: "Owner", email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 201, `registration — got ${res.raw}`);
  return stringField(res.body, "identityToken");
}

async function registerDriver(email: string, password = PASSWORD): Promise<string> {
  const res = await inject({ url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password } });
  assert.equal(res.statusCode, 201, `driver registration — got ${res.raw}`);
  return stringField(res.body, "identityToken");
}

function lastSentTo(email: string): { message: MailMessage; sesMessageId: string } {
  const found = sent.filter(s => s.message.to === email).at(-1);
  assert.ok(found !== undefined, `expected an email to ${email}`);
  return found;
}

function tokenIn(message: MailMessage): string {
  const token = /#token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
  assert.ok(token !== undefined);
  return token;
}

/**
 * SES's notification for `sesMessageId`, signed as SNS signs it, posted to the
 * endpoint — as an identity notification (`notificationType`) or, with
 * `configurationSet`, as the Timesheets configuration set publishes it
 * (`eventType`, D58).
 */
function notify(
  sesMessageId: string,
  event: { type: "Bounce"; bounceType: string; to: string; feedbackId?: string } | { type: "Complaint"; to: string; feedbackId?: string },
  format: "identity" | "configurationSet" = "identity",
): Promise<Injected> {
  const feedbackId = event.feedbackId ?? `feedback-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const kind = format === "identity" ? { notificationType: event.type } : { eventType: event.type };
  const message = event.type === "Bounce"
    ? { ...kind, mail: { messageId: sesMessageId }, bounce: { feedbackId, timestamp, bounceType: event.bounceType, bounceSubType: "General", bouncedRecipients: [{ emailAddress: event.to.toUpperCase() }] } }
    : { ...kind, mail: { messageId: sesMessageId }, complaint: { feedbackId, timestamp, complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: event.to }] } };
  const envelope = sign({ Type: "Notification", MessageId: randomUUID(), TopicArn: TOPIC, Message: JSON.stringify(message), Timestamp: timestamp });
  return inject({ url: "/webhooks/ses", text: true, payload: JSON.stringify(envelope) });
}

async function me(token: string): Promise<unknown> {
  const res = await inject({ method: "GET", url: "/auth/me", token });
  assert.equal(res.statusCode, 200);
  return res.body;
}

async function companyAccount(email: string) {
  return prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "EmailSuppression" WHERE email LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "EmailDeliveryEvent" WHERE "feedbackId" LIKE ${"feedback-%"} AND "emailMessageId" IS NULL`;
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); sent.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

test("ED1. an email SES accepts is recorded against the ACCOUNT it was for — and nothing of its content is stored", async () => {
  const email = freshEmail();
  await registerCompany(email);
  const { sesMessageId, message } = lastSentTo(email);
  const account = await companyAccount(email);

  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { sesMessageId } });
  assert.equal(row.userId, account.id);
  assert.equal(row.sender, "accounts");
  assert.equal(message.userId, account.id);

  // The three tables hold no address beyond the suppression list's, and no message content at all.
  const columns = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('EmailMessage', 'EmailDeliveryEvent', 'EmailSuppression') ORDER BY table_name, ordinal_position`;
  assert.deepEqual(columns.map(c => `${c.table_name}.${c.column_name}`), [
    "EmailDeliveryEvent.id", "EmailDeliveryEvent.feedbackId", "EmailDeliveryEvent.kind", "EmailDeliveryEvent.detail",
    "EmailDeliveryEvent.emailMessageId", "EmailDeliveryEvent.occurredAt", "EmailDeliveryEvent.recordedAt",
    "EmailMessage.id", "EmailMessage.sesMessageId", "EmailMessage.userId", "EmailMessage.sender", "EmailMessage.sentAt",
    "EmailSuppression.email", "EmailSuppression.reason", "EmailSuppression.recordedAt",
  ]);
});

test("ED2. a HARD bounce is recorded against the email's account, suppresses the address, and the account is told", async () => {
  const email = freshEmail();
  const token = await registerCompany(email);
  const { sesMessageId } = lastSentTo(email);

  assert.equal((await notify(sesMessageId, { type: "Bounce", bounceType: "Permanent", to: email })).statusCode, 204);

  const events = await prisma.emailDeliveryEvent.findMany({ where: { emailMessage: { sesMessageId } }, include: { emailMessage: true } });
  assert.deepEqual(events.map(e => [e.kind, e.detail, e.emailMessage?.userId]), [["hard_bounce", "General", (await companyAccount(email)).id]]);
  assert.deepEqual((await prisma.emailSuppression.findMany({ where: { email } })).map(s => s.reason), ["hard_bounce"],
    "stored in canonical form, whatever case SES reported");
  assert.equal(field(await me(token), "emailDeliveryProblem"), "hard_bounce");
});

test("ED3. the same notification delivered twice is recorded ONCE", async () => {
  const email = freshEmail();
  await registerCompany(email);
  const { sesMessageId } = lastSentTo(email);
  const feedbackId = `feedback-${randomUUID()}`;

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await notify(sesMessageId, { type: "Bounce", bounceType: "Permanent", to: email, feedbackId })).statusCode, 204);
  }
  assert.equal(await prisma.emailDeliveryEvent.count({ where: { feedbackId } }), 1);
  assert.equal(await prisma.emailSuppression.count({ where: { email } }), 1);
});

test("ED4. a TRANSIENT bounce is recorded as transient and suppresses nothing — the next send still goes", async () => {
  const email = freshEmail();
  const token = await registerCompany(email);
  const { sesMessageId } = lastSentTo(email);

  for (const bounceType of ["Transient", "Undetermined"]) {
    assert.equal((await notify(sesMessageId, { type: "Bounce", bounceType, to: email })).statusCode, 204);
  }
  const kinds = (await prisma.emailDeliveryEvent.findMany({ where: { emailMessage: { sesMessageId } } })).map(e => e.kind);
  assert.deepEqual(kinds, ["transient_bounce", "transient_bounce"]);
  assert.equal(await prisma.emailSuppression.count({ where: { email } }), 0);
  assert.equal(field(await me(token), "emailDeliveryProblem"), null);
  assert.equal((await inject({ url: "/auth/email-verification", token })).statusCode, 204, "a resend still goes");
});

test("ED5. a COMPLAINT is recorded as its own kind and its own suppression reason, beside a bounce", async () => {
  const email = freshEmail();
  const token = await registerCompany(email);
  const { sesMessageId } = lastSentTo(email);

  await notify(sesMessageId, { type: "Complaint", to: email });
  assert.deepEqual((await prisma.emailDeliveryEvent.findMany({ where: { emailMessage: { sesMessageId } } })).map(e => [e.kind, e.detail]), [["complaint", "abuse"]]);
  assert.deepEqual((await prisma.emailSuppression.findMany({ where: { email } })).map(s => s.reason), ["complaint"]);
  assert.equal(field(await me(token), "emailDeliveryProblem"), "complaint");

  await notify(sesMessageId, { type: "Bounce", bounceType: "Permanent", to: email });
  assert.deepEqual((await prisma.emailSuppression.findMany({ where: { email }, orderBy: { reason: "asc" } })).map(s => s.reason), ["hard_bounce", "complaint"]);
  assert.equal(field(await me(token), "emailDeliveryProblem"), "hard_bounce", "the worse problem is the one shown");
});

test("ED6. a suppressed address is not asked again: the owner's resend is refused honestly; the public reset sends nothing", async () => {
  const email = freshEmail();
  const token = await registerCompany(email);
  await notify(lastSentTo(email).sesMessageId, { type: "Bounce", bounceType: "Permanent", to: email });
  const sentBefore = sent.length;

  const resend = await inject({ url: "/auth/email-verification", token });
  assert.equal(resend.statusCode, 409);
  assert.deepEqual(resend.body, UNDELIVERABLE);

  const forgot = await inject({ url: "/auth/password/forgot", payload: { email } });
  assert.equal(forgot.statusCode, 204, "the public answer is unchanged — it reveals nothing");
  assert.equal(sent.length, sentBefore, "nothing was sent to the suppressed address");
});

test("ED7. boundaries: the bounce belongs to the account its email was for; the same-email driver and another company see no event of it", async () => {
  const email = freshEmail();
  const driverToken = await registerDriver(email);
  const companyToken = await registerCompany(email);
  const otherToken = await registerCompany(freshEmail());
  const { sesMessageId } = lastSentTo(email);

  await notify(sesMessageId, { type: "Bounce", bounceType: "Permanent", to: email });

  const company = await companyAccount(email);
  const driver = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "driver", email } } });
  const linked = await prisma.emailDeliveryEvent.findMany({ where: { emailMessage: { sesMessageId } }, include: { emailMessage: true } });
  assert.deepEqual(linked.map(e => e.emailMessage?.userId), [company.id], "recorded against the COMPANY account only");
  assert.equal(await prisma.emailMessage.count({ where: { userId: driver.id } }), 0, "nothing was recorded against the driver account");

  // The mailbox itself does not receive mail — for either account, as SES's own list holds it.
  assert.equal(field(await me(companyToken), "emailDeliveryProblem"), "hard_bounce");
  assert.equal(field(await me(driverToken), "emailDeliveryProblem"), "hard_bounce", "the same mailbox, the driver's own address");
  // Another company learns nothing.
  const other = await me(otherToken);
  assert.equal(field(other, "emailDeliveryProblem"), null);
  assert.ok(!JSON.stringify(other).includes(email));
});

test("ED8. a mistyped registration address is corrected: password proved, old link dead, new address confirmed, company created", async () => {
  const typo = freshEmail();
  const token = await registerCompany(typo);
  const oldLink = tokenIn(lastSentTo(typo).message);
  const corrected = freshEmail();

  const res = await inject({ url: "/auth/email/correction", token, payload: { email: ` ${corrected.toUpperCase()} `, currentPassword: PASSWORD } });
  assert.equal(res.statusCode, 204, `correction — got ${res.raw}`);

  const account = await prisma.user.findUniqueOrThrow({ where: { id: (await prisma.user.findFirstOrThrow({ where: { email: corrected } })).id } });
  assert.equal(account.email, corrected, "stored canonically");
  assert.equal(account.emailVerifiedAt, null);
  assert.equal((await inject({ url: "/auth/email-verification/confirm", payload: { token: oldLink } })).statusCode, 400, "the link sent to the mistyped address is dead");

  const newLink = tokenIn(lastSentTo(corrected).message);
  const confirmed = await inject({ url: "/auth/email-verification/confirm", payload: { token: newLink } });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(await prisma.companyMembership.count({ where: { userId: account.id, role: "admin" } }), 1);
});

test("ED9. a correction is refused: wrong password, nothing wrong with the address, a suppressed new address, one another COMPANY account holds", async () => {
  const email = freshEmail();
  const token = await registerCompany(email);
  const wrong = await inject({ url: "/auth/email/correction", token, payload: { email: freshEmail(), currentPassword: "not-the-password" } });
  assert.equal(wrong.statusCode, 403);
  assert.deepEqual(wrong.body, CANONICAL_403);

  // Confirmed and nothing known against it: not a correction case.
  await inject({ url: "/auth/email-verification/confirm", payload: { token: tokenIn(lastSentTo(email).message) } });
  const fine = await inject({ url: "/auth/email/correction", token, payload: { email: freshEmail(), currentPassword: PASSWORD } });
  assert.equal(fine.statusCode, 403, "a correction, not a general change of email");

  // A pending registration may correct — but not to a suppressed address, nor another company account's.
  const pendingToken = await registerCompany(freshEmail());
  const suppressed = freshEmail();
  await prisma.emailSuppression.create({ data: { email: suppressed, reason: "hard_bounce", recordedAt: new Date() } });
  const toSuppressed = await inject({ url: "/auth/email/correction", token: pendingToken, payload: { email: suppressed, currentPassword: PASSWORD } });
  assert.equal(toSuppressed.statusCode, 409);
  assert.deepEqual(toSuppressed.body, UNDELIVERABLE);
  const toTaken = await inject({ url: "/auth/email/correction", token: pendingToken, payload: { email, currentPassword: PASSWORD } });
  assert.equal(toTaken.statusCode, 409);
  assert.equal(field(toTaken.body, "code"), "EMAIL_IN_USE");
});

test("ED10. a DRIVER account holding the new address does not block a company's correction — the kinds stay independent", async () => {
  const shared = freshEmail();
  await registerDriver(shared, "the-drivers-own-password");
  const token = await registerCompany(freshEmail());
  const res = await inject({ url: "/auth/email/correction", token, payload: { email: shared, currentPassword: PASSWORD } });
  assert.equal(res.statusCode, 204);
  const accounts = await prisma.user.findMany({ where: { email: shared }, orderBy: { accountKind: "asc" } });
  assert.deepEqual(accounts.map(a => a.accountKind), ["driver", "company"], "two accounts, unlinked");
});

test("ED11. after a hard bounce a REGISTERED company's administrator may correct the address; it must be confirmed again, and old reset links die", async () => {
  const email = freshEmail();
  const token = await registerCompany(email);
  await inject({ url: "/auth/email-verification/confirm", payload: { token: tokenIn(lastSentTo(email).message) } });
  const account = await companyAccount(email);
  await prisma.accountToken.create({
    data: { userId: account.id, purpose: "password_reset", tokenHash: `${TAG}-reset-digest`, issuedAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  });
  await notify(lastSentTo(email).sesMessageId, { type: "Bounce", bounceType: "Permanent", to: email });

  const corrected = freshEmail();
  const res = await inject({ url: "/auth/email/correction", token, payload: { email: corrected, currentPassword: PASSWORD } });
  assert.equal(res.statusCode, 204, `got ${res.raw}`);
  const correctedAccount = await prisma.user.findUniqueOrThrow({ where: { id: account.id } });
  assert.equal(correctedAccount.email, corrected);
  assert.equal(correctedAccount.emailVerifiedAt, null);
  assert.equal(await prisma.accountToken.count({ where: { userId: account.id, purpose: "password_reset" } }), 0);
  assert.equal(field(await me(token), "emailDeliveryProblem"), null, "the new address has no problem");
  assert.equal(await prisma.companyMembership.count({ where: { userId: account.id } }), 1, "the company is untouched");
});

// ── D58: the Timesheets configuration set, and only Timesheets' own mail ────

test("ED12. a CONFIGURATION-SET bounce and complaint (eventType) are recorded and suppress exactly as identity notifications do", async () => {
  const email = freshEmail();
  const token = await registerCompany(email);
  const { sesMessageId } = lastSentTo(email);

  assert.equal((await notify(sesMessageId, { type: "Bounce", bounceType: "Permanent", to: email }, "configurationSet")).statusCode, 204);
  assert.equal((await notify(sesMessageId, { type: "Complaint", to: email }, "configurationSet")).statusCode, 204);

  const events = await prisma.emailDeliveryEvent.findMany({ where: { emailMessage: { sesMessageId } }, orderBy: { occurredAt: "asc" } });
  assert.deepEqual(events.map(e => e.kind).sort(), ["complaint", "hard_bounce"]);
  assert.deepEqual((await prisma.emailSuppression.findMany({ where: { email } })).map(s => s.reason).sort(), ["complaint", "hard_bounce"]);
  assert.equal(field(await me(token), "emailDeliveryProblem"), "hard_bounce");
});

test("ED13. an event for a message Timesheets NEVER SENT records nothing and suppresses nothing — in either format", async () => {
  const email = freshEmail();
  const token = await registerCompany(email);
  const eventsBefore = await prisma.emailDeliveryEvent.count();

  // Signed, from the configured topic, naming a real Timesheets address — but
  // about an email this API never sent (another product's, or a forgery
  // signed with a stolen key cannot be told apart from it here).
  for (const format of ["identity", "configurationSet"] as const) {
    const foreign = `ses-not-ours-${randomUUID()}`;
    // Answered retryable, not acknowledged: from here an early event for our
    // own send is indistinguishable from a foreign one (ED15).
    assert.equal((await notify(foreign, { type: "Bounce", bounceType: "Permanent", to: email }, format)).statusCode, 503, format);
    assert.equal((await notify(foreign, { type: "Complaint", to: email }, format)).statusCode, 503, format);
  }

  assert.equal(await prisma.emailDeliveryEvent.count(), eventsBefore, "no event row for a message that is not ours");
  assert.equal(await prisma.emailSuppression.count({ where: { email } }), 0, "and the address is NOT suppressed");
  assert.equal(field(await me(token), "emailDeliveryProblem"), null, "the account is not told of someone else's bounce");

  // Positive control: the same address's OWN email still records.
  const { sesMessageId } = lastSentTo(email);
  assert.equal((await notify(sesMessageId, { type: "Bounce", bounceType: "Permanent", to: email }, "configurationSet")).statusCode, 204);
  assert.equal(await prisma.emailSuppression.count({ where: { email } }), 1);
});

test("ED14. the same configuration-set event delivered three times is recorded ONCE", async () => {
  const email = freshEmail();
  await registerCompany(email);
  const { sesMessageId } = lastSentTo(email);
  const feedbackId = `feedback-${randomUUID()}`;

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await notify(sesMessageId, { type: "Bounce", bounceType: "Permanent", to: email, feedbackId }, "configurationSet")).statusCode, 204);
  }
  assert.equal(await prisma.emailDeliveryEvent.count({ where: { feedbackId } }), 1);
  assert.equal(await prisma.emailSuppression.count({ where: { email } }), 1);
});

test("ED15. a bounce that ARRIVES BEFORE its send is recorded is not lost: answered retryable, recorded on redelivery once the send is attributed", async () => {
  const email = freshEmail();
  const token = await registerCompany(email);
  const account = await companyAccount(email);
  // SES has accepted the email, but the send has not yet been recorded —
  // SNS can deliver the bounce inside that window.
  const sesMessageId = `ses-early-${randomUUID()}`;
  const feedbackId = `feedback-${randomUUID()}`;
  const bounce = { type: "Bounce", bounceType: "Permanent", to: email, feedbackId } as const;

  const early = await notify(sesMessageId, bounce, "configurationSet");
  assert.equal(early.statusCode, 503, `SNS retries only a 5xx or 429 — got ${early.raw}`);
  assert.equal(field(early.body, "code"), "NOT_YET_RECORDED");
  assert.equal(await prisma.emailDeliveryEvent.count({ where: { feedbackId } }), 0, "nothing is recorded early");
  assert.equal(await prisma.emailSuppression.count({ where: { email } }), 0, "and nothing is suppressed early");

  // The send's own record lands, then SNS redelivers the same event.
  const { emailDeliveryRepository } = await import("../../repositories/emailDeliveryRepository.js");
  await emailDeliveryRepository(prisma).recordSent({ sesMessageId, userId: account.id, sender: "accounts" });
  assert.equal((await notify(sesMessageId, bounce, "configurationSet")).statusCode, 204);

  const events = await prisma.emailDeliveryEvent.findMany({ where: { feedbackId }, include: { emailMessage: true } });
  assert.deepEqual(events.map(e => [e.kind, e.emailMessage?.userId]), [["hard_bounce", account.id]]);
  assert.equal(await prisma.emailSuppression.count({ where: { email } }), 1);
  assert.equal(field(await me(token), "emailDeliveryProblem"), "hard_bounce");
});
