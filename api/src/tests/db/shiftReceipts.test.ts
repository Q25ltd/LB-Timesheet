/**
 * D66, stage S3 — start receipts: server evidence that a company's day
 * existed while the driver's membership was active.
 *
 *   POST /driver/shift-receipts   identity posture — `authorizeTimesheetSubmission`
 *
 * The phone queues one when a company's day starts (or a day is made a
 * company's) and sends it when it can; it never blocks working offline. The
 * server keeps ITS OWN `receivedAt` — the only time that counts as evidence —
 * and refuses a receipt for a membership that is not active. Receipts are
 * not company-visible. Real accounts, memberships and tokens.
 *
 * WRITTEN RED. Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import type { MailMessage, Mailer } from "../../lib/mailer.js";
import { AppError } from "../../lib/errors.js";
import { recordStartReceipt } from "../../services/startReceipts.js";
import { startReceiptRepository, submissionMembershipLookup } from "../../repositories/startReceiptRepository.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the shift receipt tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `shift-receipts-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const RECEIPTS = "/driver/shift-receipts";
const START = "2026-10-11T04:00:00.000Z";

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

function receipt(identityToken: string, payload: object): Promise<Injected> {
  return inject({ url: RECEIPTS, token: identityToken, payload });
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "ShiftStartReceipt" WHERE "companyId" IN (SELECT id FROM "Company" WHERE name LIKE ${`${TAG}%`})`;
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

const act = (admin: Admin, membershipId: string, action: "deactivate" | "remove") =>
  inject({ url: `/company/drivers/${membershipId}/${action}`, token: admin.token });

test("SR1. an ACTIVE membership's receipt is kept with the SERVER's receivedAt, and the day's date as the company files it — from the DECLARED start", async () => {
  const admin = await companyAdmin({ timeZone: "Asia/Tokyo" });
  const me = await driverOf(admin);
  const clientEventId = randomUUID();
  const sentAt = Date.now();

  // 15:30Z on 10 Oct is 00:30 on 11 Oct in Tokyo: the company's date.
  const res = await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId, startedAt: "2026-10-10T15:30:00.000Z" });

  assert.equal(res.statusCode, 201, `got ${res.raw}`);
  const receivedAt = Date.parse(stringField(field(res.body, "receipt"), "receivedAt"));
  assert.ok(receivedAt >= sentAt - 1000 && receivedAt <= Date.now() + 1000, "the server's clock, not the phone's");
  const row = await prisma.shiftStartReceipt.findFirstOrThrow({ where: { membershipId: me.membershipId, clientEventId } });
  assert.equal(row.companyId, admin.companyId);
  assert.equal(row.userId, me.userId);
  assert.equal(row.declaredStartedAt.toISOString(), "2026-10-10T15:30:00.000Z");
  assert.equal(row.shiftDate.toISOString().slice(0, 10), "2026-10-11");
  assert.equal(row.companyTimezone, "Asia/Tokyo");
});

test("SR2. the same receipt sent again is the SAME receipt — its first receivedAt, one row; a different start under the same id is refused", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const body = { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: "2026-10-11T05:00:00+03:00" };
  const first = await receipt(me.identityToken, body);

  const again = await receipt(me.identityToken, body);

  assert.equal(again.statusCode, 200, `got ${again.raw}`);
  assert.deepEqual(field(again.body, "receipt"), field(first.body, "receipt"));
  assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 1);
  const changed = await receipt(me.identityToken, { ...body, startedAt: "2026-10-11T06:00:00+03:00" });
  assert.equal(changed.statusCode, 409);
  assert.equal(field(changed.body, "code"), "RECEIPT_MISMATCH");
});

test("SR3. a DEACTIVATED or REMOVED membership gets no receipt — the generic 403 — so a withdrawn driver can never make a verified start", async () => {
  for (const action of ["deactivate", "remove"] as const) {
    const admin = await companyAdmin();
    const me = await driverOf(admin);
    assert.equal((await act(admin, me.membershipId, action)).statusCode, 200);

    const res = await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() });

    assert.equal(res.statusCode, 403, `${action}: got ${res.raw}`);
    assert.deepEqual(res.body, { error: "Not allowed", code: "FORBIDDEN" });
    assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 0);
  }
});

test("SR4. a membership that is not the signed-in driver's — another driver's, an administrator's, or none — is the same 404", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const other = await driverOf(admin);
  const adminMembership = await prisma.companyMembership.findFirstOrThrow({ where: { companyId: admin.companyId, role: "admin" } });
  const body = (membershipId: string) => ({ membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() });

  const theirs = await receipt(me.identityToken, body(other.membershipId));
  const nobodys = await receipt(me.identityToken, body("c" + "x".repeat(24)));
  const admins = await receipt(me.identityToken, body(adminMembership.id));

  assert.equal(theirs.statusCode, 404);
  assert.equal(theirs.raw, nobodys.raw, "byte-identical");
  assert.equal(admins.raw, nobodys.raw);
  assert.equal(await prisma.shiftStartReceipt.count({ where: { companyId: admin.companyId } }), 0);
});

test("SR5. the identity token only: a tenant token is the wrong kind (401), no token 401", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const tenant = stringField((await inject({ url: "/auth/switch-company", token: me.identityToken, payload: { membershipId: me.membershipId } })).body, "tenantToken");
  const body = { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() };

  assert.equal((await receipt(tenant, body)).statusCode, 401);
  assert.equal((await inject({ url: RECEIPTS, payload: body })).statusCode, 401);
});

test("SR6. strict: a company, a user or a date from the client is refused; an id must be a UUID; a start must carry its offset", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const ok = { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: "2026-10-11T05:00:00+03:00" };
  for (const payload of [
    { ...ok, companyId: admin.companyId }, { ...ok, userId: me.userId }, { ...ok, shiftDate: "2026-10-11" },
    { ...ok, clientEventId: "not-a-uuid" }, { ...ok, startedAt: "2026-10-11T05:00:00" }, { ...ok, membershipId: "" },
  ]) {
    const res = await receipt(me.identityToken, payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload).slice(0, 80)} — got ${res.raw}`);
  }
  assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 0);
});

test("SR7. at most 50 NEW receipts per membership a day — a replay of one already kept is never counted or refused", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const kept = { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() };
  assert.equal((await receipt(me.identityToken, kept)).statusCode, 201);
  await prisma.shiftStartReceipt.createMany({
    data: Array.from({ length: 49 }, () => ({
      companyId: admin.companyId, membershipId: me.membershipId, userId: me.userId, clientEventId: randomUUID(),
      declaredStartedAt: new Date(), shiftDate: new Date("2026-10-11"), companyTimezone: "Europe/Vilnius",
    })),
  });

  const fiftyFirst = await receipt(me.identityToken, { ...kept, clientEventId: randomUUID() });
  assert.equal(fiftyFirst.statusCode, 429, `got ${fiftyFirst.raw}`);
  assert.equal((await receipt(me.identityToken, kept)).statusCode, 200, "the replay still answers");
});

test("SR8. the DATABASE binds a receipt to its membership's own company and user, and keeps one per membership and id", async () => {
  const a = await companyAdmin();
  const b = await companyAdmin();
  const me = await driverOf(a);
  const row = { membershipId: me.membershipId, userId: me.userId, clientEventId: randomUUID(), declaredStartedAt: new Date(), shiftDate: new Date("2026-10-11"), companyTimezone: "Europe/Vilnius" };

  await assert.rejects(prisma.shiftStartReceipt.create({ data: { ...row, companyId: b.companyId } }), "another company");
  await prisma.shiftStartReceipt.create({ data: { ...row, companyId: a.companyId } });
  await assert.rejects(prisma.shiftStartReceipt.create({ data: { ...row, companyId: a.companyId } }), "one per membership and id");
});

// ═══════════════════════════════════════════════════════════════════════════
// Security review remediation (2026-10-17): R2, R3, R4
// ═══════════════════════════════════════════════════════════════════════════

async function seedReceipts(admin: Admin, me: { userId: string; membershipId: string }, count: number): Promise<void> {
  await prisma.shiftStartReceipt.createMany({
    data: Array.from({ length: count }, () => ({
      companyId: admin.companyId, membershipId: me.membershipId, userId: me.userId, clientEventId: randomUUID(),
      declaredStartedAt: new Date(), shiftDate: new Date("2026-10-11"), companyTimezone: "Europe/Vilnius",
    })),
  });
}

test("SR9. (R2) the daily cap holds under CONCURRENCY: 49 kept, five new at once → exactly one more (50), four refused 429 — and a replay at the cap still answers", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const kept = { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() };
  assert.equal((await receipt(me.identityToken, kept)).statusCode, 201);
  await seedReceipts(admin, me, 48);

  const answers = await Promise.all(Array.from({ length: 5 }, () =>
    receipt(me.identityToken, { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() })));

  assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 50, "the cap was exceeded");
  assert.deepEqual(answers.map(answer => answer.statusCode).sort(), [201, 429, 429, 429, 429]);
  const replays = await Promise.all([receipt(me.identityToken, kept), receipt(me.identityToken, kept)]);
  assert.deepEqual(replays.map(answer => answer.statusCode), [200, 200], "a replay is never counted or refused");
});

/**
 * Holds every caller of `method` until `parties` have arrived (or a short
 * wait passes): the deterministic form of "all of them counted before any of
 * them wrote". A repository without the method is returned unchanged.
 */
function barrierOn<T extends object>(repository: T, method: string, parties: number): T {
  let arrived = 0;
  let release: () => void = () => undefined;
  const all = new Promise<void>(resolve => { release = resolve; });
  return new Proxy(repository, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key !== method || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(value, target, args);
        arrived += 1;
        if (arrived >= parties) release();
        await Promise.race([all, new Promise(resolve => setTimeout(resolve, 500))]);
        return result;
      };
    },
  });
}

test("SR9b. (R2) the reviewer's scenario, forced: 49 kept, five new that ALL pass the pre-check before any writes → still 50, never 54", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  await seedReceipts(admin, me, 49);
  const receipts = barrierOn(startReceiptRepository(prisma), "find", 5);

  const outcomes = await Promise.all(Array.from({ length: 5 }, () => recordStartReceipt(
    { userId: me.userId, sessionId: "test" },
    { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() },
    submissionMembershipLookup(prisma), receipts,
  ).then(() => 201, (error: unknown) => (error instanceof AppError ? error.statusCode : 500))));

  assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 50, "count-then-insert let the cap through");
  assert.deepEqual(outcomes.sort(), [201, 429, 429, 429, 429]);
});

test("SR9c. (R2) two copies of the SAME new day at the cap's edge: one is kept (the 50th), the other is its replay — never counted, never refused", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  await seedReceipts(admin, me, 49);
  const receipts = barrierOn(startReceiptRepository(prisma), "find", 2);
  const body = { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() };

  const outcomes = await Promise.all([0, 1].map(() => recordStartReceipt({ userId: me.userId, sessionId: "test" }, body, submissionMembershipLookup(prisma), receipts)
    .then(result => (result.created ? 201 : 200), (error: unknown) => (error instanceof AppError ? error.statusCode : 500))));

  assert.deepEqual(outcomes.sort(), [200, 201]);
  assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 50);
});

test("SR10. (R3) a withdrawal that COMMITS between the driver's authorisation and the receipt's write: no receipt is issued — deterministic interleaving", async () => {
  for (const action of ["deactivate", "remove"] as const) {
    const admin = await companyAdmin();
    const me = await driverOf(admin);
    const lookup = submissionMembershipLookup(prisma);
    let withdrawn = false;
    // The read sees the membership ACTIVE; the withdrawal then commits before the write.
    const racing = {
      async findOwnDriverMembership(userId: string, membershipId: string) {
        const row = await lookup.findOwnDriverMembership(userId, membershipId);
        if (!withdrawn) {
          withdrawn = true;
          assert.equal((await act(admin, me.membershipId, action)).statusCode, 200);
        }
        return row;
      },
    };

    const outcome = await recordStartReceipt(
      { userId: me.userId, sessionId: "test" },
      { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() },
      racing, startReceiptRepository(prisma),
    ).then(() => "issued", (error: unknown) => (error instanceof AppError ? error.statusCode : "threw"));

    assert.equal(outcome, 403, `${action}: a receipt was issued after the withdrawal committed`);
    assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 0);
  }
});

test("SR11. (R4) an UPPERCASE UUID is the same id: kept in canonical lowercase (never a 500 from the database's check), and the lowercase replay is the same receipt", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const id = randomUUID();
  const startedAt = new Date().toISOString();

  const upper = await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId: id.toUpperCase(), startedAt });
  assert.equal(upper.statusCode, 201, `got ${upper.raw}`);
  const stored = await prisma.shiftStartReceipt.findMany({ where: { membershipId: me.membershipId } });
  assert.deepEqual(stored.map(row => row.clientEventId), [id]);

  const lower = await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId: id, startedAt });
  // The reviewer's literal input.
  const reviewed = await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId: "ABCDEFAB-1234-4234-8234-ABCDEFABCDEF", startedAt });
  assert.equal(reviewed.statusCode, 201, `got ${reviewed.raw}`);
  assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId, clientEventId: "abcdefab-1234-4234-8234-abcdefabcdef" } }), 1);
  assert.equal(lower.statusCode, 200, "the same day in another case is a replay");
  assert.deepEqual(lower.body, upper.body);
  const mixed = await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId: `${id.slice(0, 18).toUpperCase()}${id.slice(18)}`, startedAt });
  assert.equal(mixed.statusCode, 200);
  assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 2);
});

test("SR12. (R3) a receipt that holds the membership's lock FIRST is issued before the withdrawal — and the withdrawal, waiting for it, is recorded no earlier than the receipt", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const clientEventId = randomUUID();
  const pending: { withdrawal: Promise<Injected> | null } = { withdrawal: null };
  let issuedAt = new Date(0);

  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "CompanyMembership" WHERE id = ${me.membershipId} FOR UPDATE`;
    // The withdrawal starts now and must wait for the lock this "receipt" holds.
    pending.withdrawal = act(admin, me.membershipId, "deactivate");
    for (let waited = 0; waited < 50; waited += 1) {
      const blocked = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      if ((blocked[0]?.n ?? 0n) > 0n) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    issuedAt = new Date();
    await tx.shiftStartReceipt.create({ data: {
      companyId: admin.companyId, membershipId: me.membershipId, userId: me.userId, clientEventId,
      declaredStartedAt: new Date(START), shiftDate: new Date("2026-10-11"), companyTimezone: "Europe/London", receivedAt: issuedAt,
    } });
  });
  assert.ok(pending.withdrawal !== null);
  assert.equal((await pending.withdrawal).statusCode, 200);

  const event = await prisma.membershipEvent.findFirstOrThrow({ where: { membershipId: me.membershipId, kind: "deactivated" } });
  assert.ok(event.occurredAt.getTime() >= issuedAt.getTime(), `the withdrawal was dated ${event.occurredAt.toISOString()}, before the receipt it waited for (${issuedAt.toISOString()})`);
});
