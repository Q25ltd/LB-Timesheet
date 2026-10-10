/**
 * D63, stage 1 — a company adds its drivers: the invitation schema and the
 * company invitation API.
 *
 *   POST  /company/driver-invitations              add a driver (invite)
 *   GET   /company/driver-invitations              this company's invitations
 *   PATCH /company/driver-invitations/:id          correct a pending one
 *   POST  /company/driver-invitations/:id/cancel   cancel a pending one
 *
 * Driven with REAL accounts, sessions, memberships and tokens issued by the
 * real endpoints, against a real database. What this file proves:
 *
 *   - only an active company administrator, for its OWN company (D54);
 *   - Company B can neither see nor touch Company A's invitations;
 *   - adding an email never reveals whether a LogisticBay account uses it;
 *   - one open invitation per company and email; 30-day expiry;
 *   - the abuse limits: 50 per company per 24 hours (told), 3 emails per
 *     address per 7 days across companies (NOT told — that would leak);
 *   - the invitation email: fixed wording, escaped company name, no token,
 *     tracked on the invitation and never in the account email records;
 *   - the database itself refuses a second open invitation and bad values.
 *
 * WRITTEN RED. Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import type { MailMessage, Mailer } from "../../lib/mailer.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the driver invitation tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `driver-invitation-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const CANONICAL_403 = { error: "Not allowed", code: "FORBIDDEN" };
const INVITATIONS = "/company/driver-invitations";
const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

const outbox: MailMessage[] = [];
/** What the next send answers as the provider's message id — null, as the outbox does, unless a test sets one. */
let nextMessageId: string | null = null;
const capturingMailer: Mailer = {
  send(message) {
    outbox.push(message);
    const id = nextMessageId;
    nextMessageId = null;
    return Promise.resolve(id);
  },
};

interface Injected { statusCode: number; body: unknown; raw: string }

async function inject(options: { url: string; method?: "GET" | "POST" | "PATCH"; payload?: object; token?: string; web?: boolean }): Promise<Injected> {
  const app = await buildApp(prisma, { mailer: capturingMailer });
  try {
    const headers: Record<string, string> = {};
    if (options.web === true) headers["origin"] = ORIGIN;
    if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
    const res = await app.inject({
      method: options.method ?? "POST", url: options.url, headers,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown), raw: res.body };
  } finally {
    // Closing waits for background work, so an invitation's email has been
    // attempted by the time a test looks at the outbox.
    await app.close();
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

/** Register a company through the real website flow and open its emailed link: Company + its first admin. */
async function registeredCompany(email: string, companyName: string): Promise<{ companyId: string; membershipId: string }> {
  const registered = await inject({
    url: "/auth/web/register", web: true,
    payload: { companyName, timeZone: "Asia/Tokyo", firstName: "Aiko", lastName: "Sato", email, password: PASSWORD },
  });
  assert.equal(registered.statusCode, 201, `registration — got ${registered.raw}`);
  const message = outbox.filter(m => m.to === email).at(-1);
  const token = message === undefined ? undefined : /#token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
  assert.ok(token !== undefined, "the registration sent its verification link");
  const confirmed = await inject({ url: "/auth/email-verification/confirm", payload: { token } });
  assert.equal(confirmed.statusCode, 200, `confirmation — got ${confirmed.raw}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
  const membership = await prisma.companyMembership.findFirstOrThrow({ where: { userId: user.id } });
  return { companyId: membership.companyId, membershipId: membership.id };
}

/** A company and its administrator's tenant token, from the real website sign-in. */
async function companyAdmin(name: string): Promise<{ companyId: string; token: string }> {
  const email = freshEmail();
  const company = await registeredCompany(email, `${TAG}-${name}`);
  const login = await inject({ url: "/auth/web/login", web: true, payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, `company sign-in — got ${login.raw}`);
  outbox.length = 0;
  return { companyId: company.companyId, token: stringField(login.body, "tenantToken") };
}

/** Make an invitation as old as a lapsed one really is: made 31 days ago, expired a day ago. */
function lapsed(): { createdAt: Date; expiresAt: Date } {
  return { createdAt: new Date(Date.now() - 31 * DAY_MS), expiresAt: new Date(Date.now() - DAY_MS) };
}

/** A driver account from the phone's registration — no company. */
async function driverAccount(email: string): Promise<{ userId: string; identityToken: string }> {
  const registered = await inject({ url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password: PASSWORD } });
  assert.equal(registered.statusCode, 201, `driver registration — got ${registered.raw}`);
  return { userId: stringField(field(registered.body, "user"), "id"), identityToken: stringField(registered.body, "identityToken") };
}

/** A driver account with an ACTIVE driver membership of `companyId`, and its tenant token. */
async function driverOf(companyId: string, email: string): Promise<{ userId: string; tenantToken: string }> {
  const { userId } = await driverAccount(email);
  await prisma.companyMembership.create({ data: { companyId, userId, accountKind: "driver", role: "driver", active: true } });
  const login = await inject({ url: "/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, `driver sign-in — got ${login.raw}`);
  return { userId, tenantToken: stringField(login.body, "tenantToken") };
}

function invite(token: string, payload: object): Promise<Injected> {
  return inject({ url: INVITATIONS, token, payload });
}

function newDriver(email: string, over: object = {}): object {
  return { firstName: "John", lastName: "Smith", email, payrollRef: "EMP-001", ...over };
}

function invitationOf(res: Injected): Record<string, unknown> {
  const invitation = field(res.body, "invitation");
  assert.ok(typeof invitation === "object" && invitation !== null, `the response carries the invitation — got ${res.raw}`);
  return Object.fromEntries(Object.entries(invitation));
}

/** An invitation as the company sees it, without what differs between any two (id, times). */
function shapeOf(res: Injected): Record<string, unknown> {
  const { id: _id, createdAt: _created, expiresAt: _expires, ...rest } = invitationOf(res);
  return { status: res.statusCode, keys: Object.keys(invitationOf(res)).sort(), ...rest };
}

function invitationEmailsTo(address: string): MailMessage[] {
  return outbox.filter(message => message.to.toLowerCase() === address.toLowerCase());
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Company" WHERE id IN (
    SELECT m."companyId" FROM "CompanyMembership" m JOIN "User" u ON u.id = m."userId" WHERE u.email LIKE ${`${TAG}%`})`;
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "EmailSuppression" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; nextMessageId = null; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═══════════════════════════════════════════════════════════════════════════
// Adding a driver
// ═══════════════════════════════════════════════════════════════════════════

test("DI1. an administrator adds a driver: a PENDING invitation for 30 days, with exactly what the company typed, and one invitation email", async () => {
  const admin = await companyAdmin("Northgate");
  const email = freshEmail();
  const startedAt = Date.now();

  const res = await invite(admin.token, newDriver(email, { firstName: "  John ", lastName: " Smith  ", payrollRef: " EMP-001 " }));

  assert.equal(res.statusCode, 201, `got ${res.raw}`);
  const view = invitationOf(res);
  assert.deepEqual(
    { firstName: view["firstName"], lastName: view["lastName"], email: view["email"], payrollRef: view["payrollRef"], status: view["status"] },
    { firstName: "John", lastName: "Smith", email, payrollRef: "EMP-001", status: "pending" },
  );
  const expiresIn = Date.parse(stringField(view, "expiresAt")) - Date.parse(stringField(view, "createdAt"));
  assert.equal(expiresIn, 30 * DAY_MS, "an invitation expires 30 days after it is made");
  const row = await prisma.driverInvitation.findUniqueOrThrow({ where: { id: stringField(view, "id") } });
  assert.equal(row.companyId, admin.companyId, "the invitation belongs to the administrator's company — from the token, never the body");
  assert.ok(row.createdAt.getTime() >= startedAt - 1000);

  const sent = invitationEmailsTo(email);
  assert.equal(sent.length, 1, "one invitation email");
  assert.equal(sent[0]?.sender, "accounts");
  assert.equal(sent[0]?.userId, null, "an invitation email is not an account's email (D56) — it is recorded on the invitation");
});

test("DI2. only an ACTIVE company administrator: no token, an identity token and a DRIVER's tenant token are refused, and nothing is created", async () => {
  const admin = await companyAdmin("Gatekeeper");
  const driver = await driverOf(admin.companyId, freshEmail());
  const loner = await driverAccount(freshEmail());
  const email = freshEmail();

  const anonymous = await inject({ url: INVITATIONS, payload: newDriver(email) });
  assert.equal(anonymous.statusCode, 401);
  assert.deepEqual(anonymous.body, CANONICAL_401);

  const identityOnly = await invite(loner.identityToken, newDriver(email));
  assert.ok(identityOnly.statusCode === 401 || identityOnly.statusCode === 403, `an identity token reaches no tenant route — got ${identityOnly.raw}`);

  const asDriver = await invite(driver.tenantToken, newDriver(email));
  assert.equal(asDriver.statusCode, 403, "a driver of the SAME company is not its administrator");
  assert.deepEqual(asDriver.body, CANONICAL_403);
  for (const method of ["GET"] as const) {
    const listed = await inject({ url: INVITATIONS, method, token: driver.tenantToken });
    assert.equal(listed.statusCode, 403);
  }

  // A deactivated administrator is refused too (D54: an ACTIVE membership).
  await prisma.companyMembership.updateMany({ where: { companyId: admin.companyId, role: "admin" }, data: { active: false } });
  const inactive = await invite(admin.token, newDriver(email));
  assert.ok(inactive.statusCode === 401 || inactive.statusCode === 403, `an inactive administrator is refused — got ${inactive.raw}`);

  assert.equal(await prisma.driverInvitation.count({ where: { email } }), 0);
  assert.equal(invitationEmailsTo(email).length, 0);
});

test("DI3. Company B can neither see nor change nor cancel Company A's invitations — answered exactly as for one that does not exist", async () => {
  const a = await companyAdmin("A-Haulage");
  const b = await companyAdmin("B-Haulage");
  const created = await invite(a.token, newDriver(freshEmail()));
  const id = stringField(invitationOf(created), "id");

  const listedByB = await inject({ url: INVITATIONS, method: "GET", token: b.token });
  assert.equal(listedByB.statusCode, 200);
  assert.deepEqual(field(listedByB.body, "invitations"), [], "B sees none of A's");

  const missing = "c" + "x".repeat(24);
  for (const [label, target] of [["A's", id], ["a nonexistent", missing]] as const) {
    const edited = await inject({ url: `${INVITATIONS}/${target}`, method: "PATCH", token: b.token, payload: { firstName: "Hijacked" } });
    const cancelled = await inject({ url: `${INVITATIONS}/${target}/cancel`, token: b.token });
    assert.equal(edited.statusCode, 404, `B editing ${label} invitation`);
    assert.equal(cancelled.statusCode, 404, `B cancelling ${label} invitation`);
  }
  const editA = await inject({ url: `${INVITATIONS}/${id}`, method: "PATCH", token: b.token, payload: { firstName: "Hijacked" } });
  const editMissing = await inject({ url: `${INVITATIONS}/${missing}`, method: "PATCH", token: b.token, payload: { firstName: "Hijacked" } });
  assert.equal(editA.raw, editMissing.raw, "byte-identical: B cannot learn that the id exists");

  const row = await prisma.driverInvitation.findUniqueOrThrow({ where: { id } });
  assert.equal(row.firstName, "John");
  assert.equal(row.status, "pending");
  const listedByA = await inject({ url: INVITATIONS, method: "GET", token: a.token });
  assert.deepEqual((field(listedByA.body, "invitations") as unknown[]).map(i => field(i, "id")), [id]);
});

test("DI4. the body is strict: a company, a status or an expiry sent by the client is refused, as are blank, overlong and malformed values", async () => {
  const admin = await companyAdmin("Strict");
  const email = freshEmail();
  const refused: object[] = [
    newDriver(email, { companyId: "someone-else" }),
    newDriver(email, { status: "accepted" }),
    newDriver(email, { expiresAt: "2099-01-01T00:00:00Z" }),
    newDriver(email, { firstName: "   " }),
    newDriver(email, { lastName: "x".repeat(201) }),
    newDriver(email, { email: "not-an-email" }),
    newDriver(email, { email: `${"x".repeat(320)}@example.com` }),
    newDriver(email, { payrollRef: "x".repeat(65) }),
    { firstName: "John", lastName: "Smith" },
  ];
  for (const payload of refused) {
    const res = await invite(admin.token, payload);
    assert.equal(res.statusCode, 400, `refused: ${JSON.stringify(payload).slice(0, 80)} — got ${res.raw}`);
    assert.equal(field(res.body, "code"), "VALIDATION");
  }
  assert.equal(await prisma.driverInvitation.count({ where: { companyId: admin.companyId } }), 0);

  const noPayroll = await invite(admin.token, newDriver(email, { payrollRef: undefined }));
  assert.equal(noPayroll.statusCode, 201, `the payroll reference is optional — got ${noPayroll.raw}`);
  assert.equal(invitationOf(noPayroll)["payrollRef"], null, "absent is null, never an empty string");
});

// ═══════════════════════════════════════════════════════════════════════════
// Nothing about LogisticBay accounts leaks to the company
// ═══════════════════════════════════════════════════════════════════════════

test("DI5. adding an email answers IDENTICALLY whether no account, a driver account, a verified driver account or another company's driver uses it", async () => {
  const admin = await companyAdmin("Discreet");
  const other = await companyAdmin("Elsewhere");
  const nobody = freshEmail();
  const unverified = freshEmail();
  await driverAccount(unverified);
  const verified = freshEmail();
  const verifiedAccount = await driverAccount(verified);
  await prisma.user.update({ where: { id: verifiedAccount.userId }, data: { emailVerifiedAt: new Date() } });
  const othersDriver = freshEmail();
  await driverOf(other.companyId, othersDriver);
  const companyAccountEmail = freshEmail();
  await registeredCompany(companyAccountEmail, `${TAG}-Lookalike`);
  outbox.length = 0;

  const shapes = [];
  for (const email of [nobody, unverified, verified, othersDriver, companyAccountEmail]) {
    const res = await invite(admin.token, newDriver(email, { email }));
    const { email: _email, ...shape } = shapeOf(res);
    shapes.push(shape);
    const [message] = invitationEmailsTo(email);
    assert.ok(message !== undefined, `an email was sent to ${email}`);
    assert.equal(message.subject, invitationEmailsTo(nobody)[0]?.subject);
    assert.equal(message.text.replaceAll(email, "ADDRESS"), invitationEmailsTo(nobody)[0]?.text.replaceAll(nobody, "ADDRESS"), "the email is the same for everyone");
  }
  for (const shape of shapes) assert.deepEqual(shape, shapes[0]);
});

test("DI6. the one refusal that names a person is the company's OWN active driver; a former driver may be invited again", async () => {
  const admin = await companyAdmin("OwnDrivers");
  const email = freshEmail();
  const driver = await driverOf(admin.companyId, email);

  const again = await invite(admin.token, newDriver(email.toUpperCase()));
  assert.equal(again.statusCode, 409, `got ${again.raw}`);
  assert.equal(field(again.body, "code"), "ALREADY_A_DRIVER");
  assert.equal(invitationEmailsTo(email).length, 0);

  await prisma.companyMembership.updateMany({ where: { userId: driver.userId }, data: { active: false } });
  const rejoin = await invite(admin.token, newDriver(email));
  assert.equal(rejoin.statusCode, 201, `rejoining needs a new invitation — and is allowed one (D63) — got ${rejoin.raw}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// One open invitation; expiry
// ═══════════════════════════════════════════════════════════════════════════

test("DI7. one open invitation per company and email — case-insensitively; another company, a cancelled or an expired one does not block", async () => {
  const admin = await companyAdmin("Once");
  const other = await companyAdmin("Twice");
  const email = freshEmail();
  const first = await invite(admin.token, newDriver(email));
  assert.equal(first.statusCode, 201);

  const duplicate = await invite(admin.token, newDriver(email.toUpperCase(), { firstName: "Johnny" }));
  assert.equal(duplicate.statusCode, 409, `got ${duplicate.raw}`);
  assert.equal(field(duplicate.body, "code"), "INVITATION_EXISTS");

  const elsewhere = await invite(other.token, newDriver(email));
  assert.equal(elsewhere.statusCode, 201, "each company invites independently");

  const id = stringField(invitationOf(first), "id");
  await prisma.driverInvitation.update({ where: { id }, data: lapsed() });
  const listed = await inject({ url: INVITATIONS, method: "GET", token: admin.token });
  assert.equal(field((field(listed.body, "invitations") as unknown[])[0], "status"), "expired", "a lapsed invitation is shown as expired");

  const renewed = await invite(admin.token, newDriver(email));
  assert.equal(renewed.statusCode, 201, `an expired invitation does not block a new one — got ${renewed.raw}`);
  assert.equal((await prisma.driverInvitation.findUniqueOrThrow({ where: { id } })).status, "expired", "and is marked expired, not left pending");

  const renewedId = stringField(invitationOf(renewed), "id");
  const cancelled = await inject({ url: `${INVITATIONS}/${renewedId}/cancel`, token: admin.token });
  assert.equal(cancelled.statusCode, 200);
  const third = await invite(admin.token, newDriver(email));
  assert.equal(third.statusCode, 201, "a cancelled invitation does not block a new one");
});

// ═══════════════════════════════════════════════════════════════════════════
// Abuse limits
// ═══════════════════════════════════════════════════════════════════════════

test("DI8. at most 50 new invitations per company per 24 hours: the 51st is refused and says so, and sends nothing", async () => {
  const admin = await companyAdmin("Busy");
  const now = Date.now();
  await prisma.driverInvitation.createMany({
    data: Array.from({ length: 50 }, (_, i) => ({
      companyId: admin.companyId, email: `${TAG}-bulk-${String(i)}@example.com`, firstName: "Bulk", lastName: String(i),
      status: "pending" as const, createdAt: new Date(now - 60_000), expiresAt: new Date(now + 30 * DAY_MS),
    })),
  });
  const email = freshEmail();

  const res = await invite(admin.token, newDriver(email));

  assert.equal(res.statusCode, 429, `got ${res.raw}`);
  assert.equal(field(res.body, "code"), "INVITATION_LIMIT");
  assert.equal(invitationEmailsTo(email).length, 0);
  assert.equal(await prisma.driverInvitation.count({ where: { email } }), 0);

  // Older than 24 hours no longer counts.
  await prisma.driverInvitation.updateMany({ where: { companyId: admin.companyId }, data: { createdAt: new Date(now - DAY_MS - 60_000) } });
  assert.equal((await invite(admin.token, newDriver(email))).statusCode, 201);
});

test("DI9. at most 3 invitation emails per address per 7 days ACROSS companies: the 4th invitation is still made, but no email — and the company cannot tell", async () => {
  const email = freshEmail();
  // Every company first: making one clears the captured outbox.
  const senders = [await companyAdmin("One"), await companyAdmin("Two"), await companyAdmin("Three")];
  const fourth = await companyAdmin("Four");
  const fifth = await companyAdmin("Five");
  for (const sender of senders) assert.equal((await invite(sender.token, newDriver(email))).statusCode, 201);
  // The recorded sends, as SES would have acknowledged them.
  await prisma.driverInvitation.updateMany({ where: { email }, data: { emailSentAt: new Date() } });
  assert.equal(invitationEmailsTo(email).length, 3);

  const control = await invite(fourth.token, newDriver(freshEmail()));
  const capped = await invite(fourth.token, newDriver(email));

  assert.equal(capped.statusCode, 201, `the invitation itself is made — got ${capped.raw}`);
  const { email: _a, ...cappedShape } = shapeOf(capped);
  const { email: _b, ...controlShape } = shapeOf(control);
  assert.deepEqual(cappedShape, controlShape, "nothing in the answer says other companies invited this person");
  assert.equal(invitationEmailsTo(email).length, 3, "but no 4th email in the week");

  await prisma.driverInvitation.updateMany({ where: { email, emailSentAt: { not: null } }, data: { emailSentAt: new Date(Date.now() - 7 * DAY_MS - 60_000) } });
  await invite(fifth.token, newDriver(email));
  assert.equal(invitationEmailsTo(email).length, 4, "sends older than 7 days no longer count");
});

// ═══════════════════════════════════════════════════════════════════════════
// The invitation email
// ═══════════════════════════════════════════════════════════════════════════

test("DI10. the email is fixed wording: the company's name escaped as text, the website the only link, no token, and it says to ignore it if not yours", async () => {
  const email = freshEmail();
  const registeredAs = `${TAG}-<b>Evil</b> & "Co" <a href="https://phish.example">click</a>`;
  const adminEmail = freshEmail();
  await registeredCompany(adminEmail, registeredAs);
  const login = await inject({ url: "/auth/web/login", web: true, payload: { email: adminEmail, password: PASSWORD } });
  outbox.length = 0;

  assert.equal((await invite(stringField(login.body, "tenantToken"), newDriver(email))).statusCode, 201);

  const [message] = invitationEmailsTo(email);
  assert.ok(message !== undefined);
  assert.ok(message.text.includes(registeredAs), "the plain-text part carries the name as typed");
  assert.ok(!message.html.includes("<b>Evil</b>") && !message.html.includes("phish.example\">"), "no markup from the company reaches the HTML");
  assert.ok(message.html.includes("&lt;b&gt;Evil&lt;/b&gt; &amp; &quot;Co&quot;"));
  const links = [...message.html.matchAll(/href="([^"]*)"/g)].map(match => match[1]);
  assert.deepEqual(links, [ORIGIN], "the website is the one link");
  assert.ok(!/token/i.test(message.text) && !/token/i.test(message.html), "an email never accepts an invitation — no token in it");
  assert.match(message.text, /ignore this email/i);
  assert.match(message.text, /John/);
});

test("DI11. a sent invitation email is recorded ON THE INVITATION — never as an account email (D56)", async () => {
  const admin = await companyAdmin("Tracked");
  const email = freshEmail();
  const driver = await driverAccount(email);
  nextMessageId = `ses-${TAG}-1`;

  const res = await invite(admin.token, newDriver(email));

  const row = await prisma.driverInvitation.findUniqueOrThrow({ where: { id: stringField(invitationOf(res), "id") } });
  assert.equal(row.sesMessageId, `ses-${TAG}-1`);
  assert.ok(row.emailSentAt !== null);
  assert.equal(await prisma.emailMessage.count({ where: { userId: driver.userId } }), 0, "nothing is recorded against the driver's account");
  assert.equal(await prisma.emailMessage.count({ where: { sesMessageId: `ses-${TAG}-1` } }), 0);
  assert.equal(field(invitationOf(res), "sesMessageId"), undefined, "the company is not shown delivery internals");
});

test("DI12. a suppressed address (hard bounce or complaint) gets no email — the invitation is still made, and the answer is unchanged", async () => {
  const admin = await companyAdmin("Careful");
  const email = freshEmail();
  await prisma.emailSuppression.create({ data: { email, reason: "complaint", recordedAt: new Date() } });
  const control = await invite(admin.token, newDriver(freshEmail()));

  const res = await invite(admin.token, newDriver(email));

  assert.equal(res.statusCode, 201);
  const { email: _a, ...shape } = shapeOf(res);
  const { email: _b, ...controlShape } = shapeOf(control);
  assert.deepEqual(shape, controlShape);
  assert.equal(invitationEmailsTo(email).length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Correcting and cancelling
// ═══════════════════════════════════════════════════════════════════════════

test("DI13. a pending invitation's names and payroll reference can be corrected — never its email, its status or its company", async () => {
  const admin = await companyAdmin("Corrector");
  const email = freshEmail();
  const id = stringField(invitationOf(await invite(admin.token, newDriver(email))), "id");

  const edited = await inject({ url: `${INVITATIONS}/${id}`, method: "PATCH", token: admin.token, payload: { firstName: " Jon ", payrollRef: null } });
  assert.equal(edited.statusCode, 200, `got ${edited.raw}`);
  assert.equal(invitationOf(edited)["firstName"], "Jon");
  assert.equal(invitationOf(edited)["lastName"], "Smith", "a field not sent is left alone");
  assert.equal(invitationOf(edited)["payrollRef"], null);

  for (const payload of [{ email: freshEmail() }, { status: "cancelled" }, { companyId: "elsewhere" }, { expiresAt: "2099-01-01T00:00:00Z" }, {}]) {
    const refused = await inject({ url: `${INVITATIONS}/${id}`, method: "PATCH", token: admin.token, payload });
    assert.equal(refused.statusCode, 400, `refused: ${JSON.stringify(payload)} — got ${refused.raw}`);
  }
  const row = await prisma.driverInvitation.findUniqueOrThrow({ where: { id } });
  assert.equal(row.email, email);
  assert.equal(row.status, "pending");
  assert.equal(invitationEmailsTo(email).length, 1, "a correction sends no second email");
});

test("DI14. cancelling ends a pending invitation; a cancelled or expired one can be neither corrected nor cancelled again", async () => {
  const admin = await companyAdmin("Canceller");
  const id = stringField(invitationOf(await invite(admin.token, newDriver(freshEmail()))), "id");

  const cancelled = await inject({ url: `${INVITATIONS}/${id}/cancel`, token: admin.token });
  assert.equal(cancelled.statusCode, 200, `got ${cancelled.raw}`);
  assert.equal(invitationOf(cancelled)["status"], "cancelled");

  const again = await inject({ url: `${INVITATIONS}/${id}/cancel`, token: admin.token });
  const edit = await inject({ url: `${INVITATIONS}/${id}`, method: "PATCH", token: admin.token, payload: { firstName: "Late" } });
  for (const res of [again, edit]) {
    assert.equal(res.statusCode, 409, `got ${res.raw}`);
    assert.equal(field(res.body, "code"), "INVITATION_NOT_PENDING");
  }

  const expiring = stringField(invitationOf(await invite(admin.token, newDriver(freshEmail()))), "id");
  await prisma.driverInvitation.update({ where: { id: expiring }, data: lapsed() });
  const lateEdit = await inject({ url: `${INVITATIONS}/${expiring}`, method: "PATCH", token: admin.token, payload: { firstName: "Late" } });
  assert.equal(lateEdit.statusCode, 409);
  assert.equal(field(lateEdit.body, "code"), "INVITATION_NOT_PENDING");

  const cancelWithBody = await inject({ url: `${INVITATIONS}/${id}/cancel`, token: admin.token, payload: { status: "pending" } });
  assert.equal(cancelWithBody.statusCode, 400, "cancel takes no body");
});

test("DI15. the list is this company's invitations, newest first, as the company typed them — no delivery internals", async () => {
  const admin = await companyAdmin("Lister");
  const first = await invite(admin.token, newDriver(freshEmail(), { firstName: "First" }));
  const second = await invite(admin.token, newDriver(freshEmail(), { firstName: "Second" }));

  const listed = await inject({ url: INVITATIONS, method: "GET", token: admin.token });

  assert.equal(listed.statusCode, 200);
  const rows = field(listed.body, "invitations") as unknown[];
  assert.deepEqual(rows.map(row => field(row, "id")), [stringField(invitationOf(second), "id"), stringField(invitationOf(first), "id")]);
  assert.deepEqual(Object.keys(rows[0] as object).sort(), ["createdAt", "email", "expiresAt", "firstName", "id", "lastName", "payrollRef", "status"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// The database's own guarantees
// ═══════════════════════════════════════════════════════════════════════════

test("DI16. the DATABASE refuses a second open invitation for one company and email — whatever the application does", async () => {
  const admin = await companyAdmin("Database");
  const email = freshEmail();
  const row = { companyId: admin.companyId, firstName: "A", lastName: "B", status: "pending" as const, expiresAt: new Date(Date.now() + DAY_MS) };
  await prisma.driverInvitation.create({ data: { ...row, email } });
  await assert.rejects(prisma.driverInvitation.create({ data: { ...row, email: email.toUpperCase() } }), /Unique constraint|P2002/);
  await prisma.driverInvitation.create({ data: { ...row, email, status: "cancelled" } });
});

test("DI17. the DATABASE refuses untrimmed or overlong names, a blank payroll reference and an expiry not after creation", async () => {
  const admin = await companyAdmin("Checks");
  const base = { companyId: admin.companyId, email: freshEmail(), firstName: "A", lastName: "B", status: "cancelled" as const, expiresAt: new Date(Date.now() + DAY_MS) };
  const bad: object[] = [
    { firstName: " A" },
    { lastName: "B " },
    { firstName: "x".repeat(201) },
    { payrollRef: "" },
    { payrollRef: " EMP" },
    { payrollRef: "x".repeat(65) },
    { createdAt: new Date(Date.now()), expiresAt: new Date(Date.now() - 1000) },
  ];
  for (const over of bad) {
    await assert.rejects(prisma.driverInvitation.create({ data: { ...base, ...over } }), `refused: ${JSON.stringify(over).slice(0, 60)}`);
  }
  await prisma.driverInvitation.create({ data: base });
});

test("DI18. deleting a company takes its invitations with it — they are the company's records, not the driver's", async () => {
  const admin = await companyAdmin("Gone");
  const id = stringField(invitationOf(await invite(admin.token, newDriver(freshEmail()))), "id");
  await prisma.$executeRaw`DELETE FROM "Company" WHERE id = ${admin.companyId}`;
  assert.equal(await prisma.driverInvitation.findUnique({ where: { id } }), null);
});
