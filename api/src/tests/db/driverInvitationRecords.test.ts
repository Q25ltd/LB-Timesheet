/**
 * D63, stage 1 (continued) — what a company's invitation sends, keeps and
 * refuses: the invitation email, correcting and cancelling, the company's
 * list, and the database's own guarantees. Split from
 * `driverInvitations.test.ts` so neither file runs into the gate's per-file
 * time limit; each has its own TAG, so their clean-ups never touch each
 * other's rows when the gate runs them side by side.
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

const TAG = `driver-invitation-records-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
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
