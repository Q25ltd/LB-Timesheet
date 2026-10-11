/**
 * D66, stage S2 — a company's verified report email address.
 *
 *   GET  /company/settings/report-email           tenant (admin) — the address and whether it is confirmed
 *   PUT  /company/settings/report-email           tenant (admin) — set or change it; a confirmation link is sent
 *   POST /company/settings/report-email/confirm   public — the emailed token is the credential
 *
 * One address per company. A token is single-use, expires, and is bound to
 * the exact address it was sent to; changing the address voids the
 * confirmation and every link still outstanding. Real accounts and tokens
 * against a real database.
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
  throw new Error("DATABASE_URL must be set to run the company report email tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `company-report-email-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const REPORT = "/company/settings/report-email";

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

const outbox: MailMessage[] = [];
const capturingMailer: Mailer = { send(message) { outbox.push(message); return Promise.resolve(null); } };

interface Injected { statusCode: number; body: unknown; raw: string }

async function inject(options: { url: string; method?: "GET" | "POST" | "PUT"; payload?: object; token?: string; web?: boolean }): Promise<Injected> {
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


function registration(email: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyName: `${TAG}-Co`, timeZone: "Europe/Vilnius", distanceUnit: "kilometre", volumeUnit: "litre",
    firstName: "Ada", lastName: "Admin", email, password: PASSWORD, ...over,
  };
}

function register(email: string, over: Record<string, unknown> = {}): Promise<Injected> {
  return inject({ url: "/auth/web/register", web: true, payload: registration(email, over) });
}

async function confirmFor(email: string): Promise<void> {
  const token = /#token=([A-Za-z0-9_-]+)/.exec(outbox.filter(m => m.to === email).at(-1)?.text ?? "")?.[1];
  assert.ok(token !== undefined, "the registration sent its link");
  assert.equal((await inject({ url: "/auth/email-verification/confirm", payload: { token } })).statusCode, 200);
}

interface Admin { companyId: string; token: string }

async function signIn(email: string): Promise<Admin> {
  const login = await inject({ url: "/auth/web/login", web: true, payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, `login — got ${login.raw}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
  const membership = await prisma.companyMembership.findFirstOrThrow({ where: { userId: user.id } });
  return { companyId: membership.companyId, token: stringField(login.body, "tenantToken") };
}

async function companyAdmin(over: Record<string, unknown> = {}): Promise<Admin> {
  const email = freshEmail();
  const res = await register(email, { companyName: `${TAG}-${String(seq)}`, ...over });
  assert.equal(res.statusCode, 201, `registration — got ${res.raw}`);
  await confirmFor(email);
  return signIn(email);
}

interface Driver { userId: string; identityToken: string; email: string }

async function driverOf(admin: Admin): Promise<Driver & { membershipId: string }> {
  const email = freshEmail();
  const registered = await inject({ url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password: PASSWORD } });
  assert.equal(registered.statusCode, 201);
  const userId = stringField(field(registered.body, "user"), "id");
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const identityToken = stringField(registered.body, "identityToken");
  const invited = await inject({ url: "/company/driver-invitations", token: admin.token, payload: { firstName: "Dee", lastName: "River", email } });
  assert.equal(invited.statusCode, 201, `invitation — got ${invited.raw}`);
  const accepted = await inject({ url: `/driver/invitations/${stringField(field(invited.body, "invitation"), "id")}/accept`, token: identityToken });
  assert.equal(accepted.statusCode, 200, `acceptance — got ${accepted.raw}`);
  return { userId, identityToken, email, membershipId: stringField(field(accepted.body, "membership"), "membershipId") };
}

const getReport = (admin: Admin): Promise<Injected> => inject({ url: REPORT, method: "GET", token: admin.token });
const putReport = (admin: Admin, email: string): Promise<Injected> => inject({ url: REPORT, method: "PUT", token: admin.token, payload: { email } });
const confirm = (token: string): Promise<Injected> => inject({ url: `${REPORT}/confirm`, payload: { token } });

/** The confirmation link's token in the last email sent to `to`. */
function linkTokenTo(to: string): string {
  const message = outbox.filter(m => m.to === to).at(-1);
  assert.ok(message !== undefined, `an email went to ${to}`);
  const token = /\/confirm-report-email#token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
  assert.ok(token !== undefined, "the email carries the confirmation link");
  return token;
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "EmailSuppression" WHERE email LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

const viewOf = (res: Injected) => field(res.body, "reportEmail");

test("RE1. a company starts with no report address", async () => {
  const admin = await companyAdmin();
  const res = await getReport(admin);
  assert.equal(res.statusCode, 200, `got ${res.raw}`);
  assert.deepEqual(viewOf(res), { address: null, verified: false });
});

test("RE2. setting the address keeps it UNCONFIRMED and sends ONE confirmation from timesheets@ to exactly that address — normalised, with no attachment", async () => {
  const admin = await companyAdmin();
  const address = `${TAG}-Payroll@Example.com`;

  const res = await putReport(admin, `  ${address}  `);

  assert.equal(res.statusCode, 200, `got ${res.raw}`);
  assert.deepEqual(viewOf(res), { address: address.toLowerCase(), verified: false });
  const sent = outbox.filter(m => m.to === address.toLowerCase());
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.sender, "timesheets");
  assert.equal(sent[0]?.userId, null, "a company's address is not an account's email (D56)");
  assert.match(sent[0]?.subject ?? "", /report/i);
  linkTokenTo(address.toLowerCase());
  const company = await prisma.company.findUniqueOrThrow({ where: { id: admin.companyId } });
  assert.deepEqual({ email: company.reportEmail, verifiedAt: company.reportEmailVerifiedAt }, { email: address.toLowerCase(), verifiedAt: null });
});

test("RE3. the link confirms the address — once: it says which company, and a second use is refused", async () => {
  const admin = await companyAdmin();
  const address = freshEmail();
  await putReport(admin, address);
  const token = linkTokenTo(address);

  const confirmed = await confirm(token);

  assert.equal(confirmed.statusCode, 200, `got ${confirmed.raw}`);
  assert.equal(field(confirmed.body, "companyName"), (await prisma.company.findUniqueOrThrow({ where: { id: admin.companyId } })).name);
  assert.deepEqual(viewOf(await getReport(admin)), { address, verified: true });
  const again = await confirm(token);
  assert.equal(again.statusCode, 400);
  assert.equal(field(again.body, "code"), "TOKEN_INVALID");
});

test("RE4. changing the address voids the confirmation AND every link still outstanding — an old link never confirms the new address", async () => {
  const admin = await companyAdmin();
  const first = freshEmail();
  await putReport(admin, first);
  await confirm(linkTokenTo(first));
  const second = freshEmail();
  await putReport(admin, second);
  const staleForSecond = linkTokenTo(second);
  const third = freshEmail();

  const changed = await putReport(admin, third);

  assert.deepEqual(viewOf(changed), { address: third, verified: false });
  const stale = await confirm(staleForSecond);
  assert.equal(stale.statusCode, 400, "a link for an address that is no longer the company's");
  assert.deepEqual(viewOf(await getReport(admin)), { address: third, verified: false });
  assert.equal((await confirm(linkTokenTo(third))).statusCode, 200);
});

test("RE5. asking again for the SAME unconfirmed address sends a new link and retires the earlier one", async () => {
  const admin = await companyAdmin();
  const address = freshEmail();
  await putReport(admin, address);
  const earlier = linkTokenTo(address);
  await putReport(admin, address);
  const later = linkTokenTo(address);

  assert.notEqual(earlier, later);
  assert.equal((await confirm(earlier)).statusCode, 400);
  assert.equal((await confirm(later)).statusCode, 200);
});

test("RE6. the address already CONFIRMED, set again: nothing changes and nothing is sent", async () => {
  const admin = await companyAdmin();
  const address = freshEmail();
  await putReport(admin, address);
  await confirm(linkTokenTo(address));
  outbox.length = 0;

  const res = await putReport(admin, address.toUpperCase());

  assert.equal(res.statusCode, 200);
  assert.deepEqual(viewOf(res), { address, verified: true });
  assert.equal(outbox.filter(m => m.sender === "timesheets").length, 0);
});

test("RE7. an expired link is refused and confirms nothing", async () => {
  const admin = await companyAdmin();
  const address = freshEmail();
  await putReport(admin, address);
  const token = linkTokenTo(address);
  await prisma.$executeRaw`UPDATE "CompanyReportEmailToken" SET "createdAt" = now() - interval '3 days', "expiresAt" = now() - interval '1 second' WHERE "companyId" = ${admin.companyId}`;

  assert.equal((await confirm(token)).statusCode, 400);
  assert.deepEqual(viewOf(await getReport(admin)), { address, verified: false });
});

test("RE8. only the company's administrator: a driver's tenant token 403, an identity token 401; a company or any other key in the body is refused; not an address → 400", async () => {
  const admin = await companyAdmin();
  const other = await companyAdmin();
  const me = await driverOf(admin);
  const driverTenant = stringField((await inject({ url: "/auth/switch-company", token: me.identityToken, payload: { membershipId: me.membershipId } })).body, "tenantToken");

  assert.equal((await inject({ url: REPORT, method: "GET", token: driverTenant })).statusCode, 403);
  assert.equal((await inject({ url: REPORT, method: "PUT", token: driverTenant, payload: { email: freshEmail() } })).statusCode, 403);
  assert.equal((await inject({ url: REPORT, method: "GET", token: me.identityToken })).statusCode, 401);
  for (const payload of [{ email: freshEmail(), companyId: other.companyId }, { email: "not-an-address" }, {}, { email: `${"a".repeat(320)}@x.co` }]) {
    const res = await inject({ url: REPORT, method: "PUT", token: admin.token, payload });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload).slice(0, 60)} — got ${res.raw}`);
  }
  assert.deepEqual(viewOf(await getReport(other)), { address: null, verified: false }, "the other company untouched");
  assert.equal(outbox.filter(m => m.sender === "timesheets").length, 0);
});

test("RE9. a link confirms ITS company's address and no other's", async () => {
  const a = await companyAdmin();
  const b = await companyAdmin();
  const shared = freshEmail();
  await putReport(a, shared);
  const tokenA = linkTokenTo(shared);
  await putReport(b, shared);

  assert.equal((await confirm(tokenA)).statusCode, 200);

  assert.deepEqual(viewOf(await getReport(a)), { address: shared, verified: true });
  assert.deepEqual(viewOf(await getReport(b)), { address: shared, verified: false }, "B confirms with B's own link");
});

test("RE10. an address SES will not deliver to is refused with the D56 code — nothing is changed and nothing is sent", async () => {
  const admin = await companyAdmin();
  const suppressed = freshEmail();
  await prisma.emailSuppression.create({ data: { email: suppressed, reason: "hard_bounce", recordedAt: new Date() } });

  const res = await putReport(admin, suppressed);

  assert.equal(res.statusCode, 409, `got ${res.raw}`);
  assert.equal(field(res.body, "code"), "EMAIL_UNDELIVERABLE");
  assert.deepEqual(viewOf(await getReport(admin)), { address: null, verified: false });
  assert.equal(outbox.filter(m => m.sender === "timesheets").length, 0);
});

test("RE11. at most 5 confirmation emails per company per hour — the sixth request is refused and changes nothing", async () => {
  const admin = await companyAdmin();
  const addresses = [1, 2, 3, 4, 5].map(() => freshEmail());
  for (const address of addresses) assert.equal((await putReport(admin, address)).statusCode, 200);
  const sixth = freshEmail();

  const res = await putReport(admin, sixth);

  assert.equal(res.statusCode, 429, `got ${res.raw}`);
  assert.deepEqual(viewOf(await getReport(admin)), { address: addresses[4], verified: false });
  assert.equal(outbox.filter(m => m.to === sixth).length, 0);
});

test("RE12. the DATABASE refuses a confirmed company with no address", async () => {
  const admin = await companyAdmin();
  await assert.rejects(prisma.company.update({ where: { id: admin.companyId }, data: { reportEmailVerifiedAt: new Date() } }));
});

test("RE13. a link confirms ONLY the address it was sent to — even a live, unretired link for another address confirms nothing", async () => {
  const admin = await companyAdmin();
  const current = freshEmail();
  await putReport(admin, current);
  // A link for an address that is not the company's, as no request writes one:
  // the binding itself — not the retiring of old links — is what refuses it.
  const { createHash, randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  await prisma.companyReportEmailToken.create({
    data: { companyId: admin.companyId, email: freshEmail(), tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3_600_000) },
  });

  assert.equal((await confirm(token)).statusCode, 400);
  assert.deepEqual(viewOf(await getReport(admin)), { address: current, verified: false });
});
