/**
 * A server fault during refresh must not cost the browser its credential.
 *
 * `POST /auth/web/refresh` tells the browser to DROP its refresh cookie when
 * the credential is refused — the cookie can do nothing any more, so keeping
 * it would only mean refusing it again. That instruction is correct for a
 * REFUSAL (401) and wrong for a FAULT: when the database is briefly
 * unreachable the server has decided nothing about the credential, the
 * Session is still live, and clearing the cookie would sign the company user
 * out for good because of an outage they could simply have waited out.
 *
 * So: a refusal clears the cookie; a fault leaves it exactly as it was, and
 * the same credential works once the fault has passed.
 *
 * WRITTEN RED.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the refresh outage tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `refresh-outage-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const COOKIE = "lbts_refresh";

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

/**
 * The real client, except that while `failing` is set every Session read or
 * write throws — what an unreachable or failing database looks like to the
 * refresh path.
 */
let failing = false;
const flaky = new Proxy(prisma, {
  get(target, property, receiver) {
    const value: unknown = Reflect.get(target, property, receiver);
    if (property !== "session" || typeof value !== "object" || value === null) return value;
    return new Proxy(value, {
      get(delegate, method, delegateReceiver) {
        const fn: unknown = Reflect.get(delegate, method, delegateReceiver);
        if (!failing || typeof fn !== "function") return fn;
        return () => Promise.reject(new Error("simulated database outage"));
      },
    });
  },
});

interface Injected { statusCode: number; setCookies: string[] }

async function post(url: string, options: { payload?: object; cookie?: string } = {}): Promise<Injected> {
  const app = await buildApp(flaky);
  try {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (options.cookie !== undefined) headers["cookie"] = options.cookie;
    const res = await app.inject({
      method: "POST",
      url,
      headers,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
    const raw = res.headers["set-cookie"];
    return { statusCode: res.statusCode, setCookies: raw === undefined ? [] : Array.isArray(raw) ? raw : [raw] };
  } finally {
    await app.close();
  }
}

/** The value of the one refresh cookie a response set, or null if it set none. */
function refreshCookieValue(res: Injected): string | null {
  const ours = res.setCookies.filter(c => c.startsWith(`${COOKIE}=`));
  assert.ok(ours.length <= 1, `at most one refresh cookie — got ${JSON.stringify(res.setCookies)}`);
  const [cookie] = ours;
  return cookie === undefined ? null : (cookie.split(";")[0] ?? "").slice(COOKIE.length + 1);
}

async function signedInBrowser(): Promise<string> {
  const res = await post("/auth/web/register", {
    payload: { firstName: "Out", lastName: "Age", email: freshEmail(), password: PASSWORD },
  });
  assert.equal(res.statusCode, 201);
  const secret = refreshCookieValue(res);
  assert.ok(secret !== null && secret !== "");
  return secret;
}

async function cleanup(): Promise<void> {
  failing = false;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); });

test("RO1. a database fault during refresh is a 5xx and leaves the browser's cookie untouched", async () => {
  const secret = await signedInBrowser();

  failing = true;
  const res = await post("/auth/web/refresh", { cookie: `${COOKIE}=${secret}` });
  failing = false;

  assert.ok(res.statusCode >= 500, `a fault is not a refusal — got ${String(res.statusCode)}`);
  assert.deepEqual(res.setCookies, [], "nothing may tell the browser to drop a credential the server never judged");
});

test("RO2. once the fault has passed, the same credential still refreshes", async () => {
  const secret = await signedInBrowser();

  failing = true;
  await post("/auth/web/refresh", { cookie: `${COOKIE}=${secret}` });
  failing = false;

  const recovered = await post("/auth/web/refresh", { cookie: `${COOKIE}=${secret}` });
  assert.equal(recovered.statusCode, 200, "the Session was never touched");
  const rotated = refreshCookieValue(recovered);
  assert.ok(rotated !== null && rotated !== "" && rotated !== secret, "and it rotated as normal");
});

test("RO3. a REFUSAL still clears the cookie — an unknown credential is told to go", async () => {
  const res = await post("/auth/web/refresh", { cookie: `${COOKIE}=${"x".repeat(43)}` });
  assert.equal(res.statusCode, 401);
  assert.equal(refreshCookieValue(res), "", "the refused cookie is cleared");
});

test("RO4. a database fault during browser LOGOUT still clears the cookie — the user asked to be signed out", async () => {
  const secret = await signedInBrowser();

  failing = true;
  const res = await post("/auth/web/logout", { cookie: `${COOKIE}=${secret}` });
  failing = false;

  assert.equal(refreshCookieValue(res), "", "this browser must hold no credential after a logout, whatever the server managed");
});
