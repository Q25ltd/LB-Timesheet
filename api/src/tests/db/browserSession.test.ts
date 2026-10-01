/**
 * The browser credential transport (D45, D46) — against a REAL database built
 * by the real migrations.
 *
 *   POST /auth/web/register   creates a BROWSER session
 *   POST /auth/web/login      creates a BROWSER session
 *   POST /auth/web/refresh    the cookie authenticates; rotates; re-sets it
 *   POST /auth/web/logout     the cookie names the session; revokes; clears it
 *
 * What a browser holds: the access token in memory (the response BODY), the
 * refresh credential ONLY in an HttpOnly, host-only cookie (a `Set-Cookie`
 * the response body never repeats). Authority is unchanged: the SAME
 * rotation, grace, reuse and revocation implementation the phone uses, with
 * the transport's client kind as a condition (D46).
 *
 * Every endpoint here acts on, or sets, an automatically-attached cookie, so
 * every one requires a request `Origin` that is exactly one of the
 * explicitly allowed Timesheets web origins (D45's CSRF baseline). SameSite
 * is set, but is not what these tests rely on.
 *
 * WRITTEN RED — none of these routes exists before this increment.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the browser session tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `browser-session-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const CANONICAL_403 = { error: "Not allowed", code: "FORBIDDEN" };
/** The development/test cookie name. Production's is `__Host-`-prefixed (unit-tested). */
const COOKIE = "lbts_refresh";
const DAY = 24 * 60 * 60 * 1000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface Injected {
  statusCode: number;
  body: unknown;
  raw: string;
  setCookies: string[];
  headers: Record<string, unknown>;
}

async function inject(options: {
  method?: "GET" | "POST" | "OPTIONS";
  url: string;
  payload?: object;
  origin?: string | null;
  cookie?: string;
  token?: string;
  headers?: Record<string, string>;
}): Promise<Injected> {
  const app = await buildApp(prisma);
  try {
    const headers: Record<string, string> = { ...options.headers };
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin !== null) headers["origin"] = origin;
    if (options.cookie !== undefined) headers["cookie"] = options.cookie;
    if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
    const res = await app.inject({
      method: options.method ?? "POST",
      url: options.url,
      headers,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
    const raw = res.headers["set-cookie"];
    const setCookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    return {
      statusCode: res.statusCode,
      body: res.body === "" ? null : (JSON.parse(res.body) as unknown),
      raw: res.body,
      setCookies,
      headers: res.headers,
    };
  } finally {
    await app.close();
  }
}

interface ParsedCookie { name: string; value: string; attributes: Map<string, string | true> }

function parseSetCookie(header: string): ParsedCookie {
  const [pair, ...rest] = header.split(";").map(part => part.trim());
  assert.ok(pair !== undefined);
  const eq = pair.indexOf("=");
  const attributes = new Map<string, string | true>();
  for (const attribute of rest) {
    const at = attribute.indexOf("=");
    if (at === -1) attributes.set(attribute.toLowerCase(), true);
    else attributes.set(attribute.slice(0, at).toLowerCase(), attribute.slice(at + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
}

/** The ONE refresh cookie a response set. */
function refreshCookieOf(res: Injected): ParsedCookie {
  const ours = res.setCookies.map(parseSetCookie).filter(c => c.name === COOKIE);
  assert.equal(ours.length, 1, `exactly one refresh cookie must be set — got ${JSON.stringify(res.setCookies)}`);
  const [cookie] = ours;
  assert.ok(cookie !== undefined);
  return cookie;
}

function maxAgeOf(cookie: ParsedCookie): number {
  const value = cookie.attributes.get("max-age");
  assert.equal(typeof value, "string", "the cookie must carry Max-Age");
  return Number(value);
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (Reflect.get(body, key) as unknown) : undefined;
}

function stringField(body: unknown, key: string): string {
  const value = field(body, key);
  assert.equal(typeof value, "string", `the response must carry \`${key}\` as a string`);
  return value as string;
}

async function webRegister(email = freshEmail()): Promise<{ email: string; res: Injected; secret: string; sessionId: string }> {
  const res = await inject({ url: "/auth/web/register", payload: { firstName: "Web", lastName: "User", email, password: PASSWORD } });
  assert.equal(res.statusCode, 201, `web registration must succeed — got ${res.raw}`);
  const secret = refreshCookieOf(res).value;
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: digest(secret) } });
  assert.ok(session !== null, "the cookie must name a persisted session");
  return { email, res, secret, sessionId: session.id };
}

function refreshWith(secret: string, origin?: string | null): Promise<Injected> {
  return inject({ url: "/auth/web/refresh", cookie: `${COOKIE}=${secret}`, origin });
}

async function kindOf(sessionId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ kind: string }[]>`
    SELECT "clientKind"::text AS kind FROM "Session" WHERE id = ${sessionId}`;
  return rows[0]?.kind ?? null;
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═════════════════════════════════════════════════════════════════════════════
// B1-B3. Creating a browser session: the secret goes ONLY into the cookie
// ═════════════════════════════════════════════════════════════════════════════

test("B1. web registration creates a BROWSER session and puts the secret ONLY in an HttpOnly host-only cookie", async () => {
  const { res, secret, sessionId } = await webRegister();

  assert.equal(field(res.body, "refreshToken"), undefined, "the refresh secret must never reach JavaScript");
  assert.ok(!res.raw.includes(secret), "not under any key, either");
  assert.ok(stringField(res.body, "identityToken").length > 0, "the access token travels in the body, for memory");
  assert.deepEqual(field(res.body, "memberships"), []);

  const cookie = refreshCookieOf(res);
  assert.equal(cookie.attributes.get("httponly"), true, "HttpOnly — never readable by JavaScript");
  assert.equal(cookie.attributes.get("samesite"), "Strict");
  assert.equal(cookie.attributes.get("path"), "/");
  assert.equal(cookie.attributes.has("domain"), false, "host-only: NO Domain attribute, never a parent domain (D3)");
  assert.ok(Math.abs(maxAgeOf(cookie) - WEEK_SECONDS) <= 5, `the cookie lives the session's 7 days, got ${String(maxAgeOf(cookie))}s`);

  assert.equal(await kindOf(sessionId), "browser");
  const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  const lifetime = session.expiresAt.getTime() - session.createdAt.getTime();
  assert.ok(Math.abs(lifetime - 7 * DAY) < 60_000, `a browser session lives 7 days, lived ${String(lifetime)}ms`);
});

test("B2. web login creates a NEW browser session with the same cookie discipline; mobile login is unchanged", async () => {
  const { email } = await webRegister();

  const res = await inject({ url: "/auth/web/login", payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `web login must succeed — got ${res.raw}`);
  assert.equal(field(res.body, "refreshToken"), undefined);
  const cookie = refreshCookieOf(res);
  assert.equal(cookie.attributes.get("httponly"), true);
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: digest(cookie.value) } });
  assert.ok(session !== null);
  assert.equal(await kindOf(session.id), "browser");

  // Positive control on the phone's endpoint: still a body secret, still mobile.
  const mobile = await inject({ url: "/auth/login", payload: { email, password: PASSWORD }, origin: null });
  assert.equal(mobile.statusCode, 200);
  assert.equal(mobile.setCookies.length, 0, "the phone's login sets no cookie");
  const mobileSession = await prisma.session.findUnique({ where: { refreshTokenHash: digest(stringField(mobile.body, "refreshToken")) } });
  assert.ok(mobileSession !== null);
  assert.equal(await kindOf(mobileSession.id), "mobile");
});

test("B3. a wrong password at web login is the canonical 401, sets no cookie and creates no session", async () => {
  const { email } = await webRegister();
  const sessionsBefore = await prisma.session.count({ where: { user: { email } } });

  const res = await inject({ url: "/auth/web/login", payload: { email, password: "wrong-password-entirely" } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, CANONICAL_401);
  assert.equal(res.setCookies.length, 0);
  assert.equal(await prisma.session.count({ where: { user: { email } } }), sessionsBefore);

  const unknown = await inject({ url: "/auth/web/login", payload: { email: freshEmail(), password: PASSWORD } });
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.raw, res.raw, "unknown email and wrong password are byte-identical");
});

// ═════════════════════════════════════════════════════════════════════════════
// B4-B9. Refresh through the cookie: one rotation authority
// ═════════════════════════════════════════════════════════════════════════════

test("B4. a cookie refresh rotates, re-sets the cookie, returns ONLY an identity token, and never moves expiresAt", async () => {
  const { secret, sessionId } = await webRegister();
  const prior = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });

  const res = await refreshWith(secret);

  assert.equal(res.statusCode, 200, `a live browser credential must redeem — got ${res.raw}`);
  assert.deepEqual(Object.keys(res.body as object).sort(), ["identityToken"], "the body carries the access token and nothing else");
  const next = refreshCookieOf(res);
  assert.notEqual(next.value, secret, "the credential ROTATES");
  assert.equal(next.attributes.get("httponly"), true);

  const latest = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  assert.equal(latest.refreshTokenHash, digest(next.value), "the new cookie's digest is CURRENT");
  assert.equal(latest.previousRefreshTokenHash, digest(secret), "the presented one is PREVIOUS");
  assert.equal(latest.expiresAt.getTime(), prior.expiresAt.getTime(), "rotation never extends the absolute lifetime");

  const me = await inject({ method: "GET", url: "/auth/me", token: stringField(res.body, "identityToken") });
  assert.equal(me.statusCode, 200, "the refreshed access token authenticates");
});

test("B5. the cookie's Max-Age never exceeds the session's REMAINING lifetime", async () => {
  const { secret, sessionId } = await webRegister();
  // An older session: one hour left of its 7 days.
  await prisma.session.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });

  const res = await refreshWith(secret);
  assert.equal(res.statusCode, 200);
  const maxAge = maxAgeOf(refreshCookieOf(res));
  assert.ok(maxAge <= 3600 && maxAge > 3500, `Max-Age must be the remaining hour, was ${String(maxAge)}s`);
});

test("B6. a MOBILE session's credential presented as the cookie is refused, rotates nothing, and the cookie is cleared", async () => {
  const mobile = await inject({
    url: "/auth/register", origin: null,
    payload: { firstName: "Mo", lastName: "Bile", email: freshEmail(), password: PASSWORD },
  });
  assert.equal(mobile.statusCode, 201);
  const secret = stringField(mobile.body, "refreshToken");
  const session = await prisma.session.findUniqueOrThrow({ where: { refreshTokenHash: digest(secret) } });

  const res = await refreshWith(secret);

  assert.equal(res.statusCode, 401, `a mobile secret must not become a browser cookie session — got ${res.raw}`);
  assert.deepEqual(res.body, CANONICAL_401);
  assert.equal(maxAgeOf(refreshCookieOf(res)), 0, "a refused cookie is cleared");
  const latest = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
  assert.equal(latest.refreshTokenHash, session.refreshTokenHash, "nothing rotated");
  assert.equal(latest.revokedAt, null, "nothing revoked");
  assert.equal(await kindOf(session.id), "mobile", "and it is still a mobile session");
});

test("B7. grace and reuse are the SAME model through the cookie", async () => {
  const { secret, sessionId } = await webRegister();
  const first = await refreshWith(secret);
  assert.equal(first.statusCode, 200);

  // The response was lost; the browser still holds `secret`, now PREVIOUS.
  const retry = await refreshWith(secret);
  assert.equal(retry.statusCode, 200, "inside the grace window the previous cookie recovers");

  // Past the window, the same previous credential is REUSE.
  await prisma.session.update({ where: { id: sessionId }, data: { previousRefreshTokenGraceUntil: new Date(Date.now() - 1000) } });
  const reuse = await refreshWith(secret);
  assert.equal(reuse.statusCode, 401);
  assert.deepEqual(reuse.body, CANONICAL_401);
  const latest = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  assert.ok(latest.revokedAt !== null, "reuse outside grace revokes the session");
});

test("B8. a revoked or expired browser session cannot refresh, and its cookie is cleared", async () => {
  const revoked = await webRegister();
  await prisma.session.update({ where: { id: revoked.sessionId }, data: { revokedAt: new Date() } });
  const r1 = await refreshWith(revoked.secret);
  assert.equal(r1.statusCode, 401);
  assert.deepEqual(r1.body, CANONICAL_401);
  assert.equal(maxAgeOf(refreshCookieOf(r1)), 0);

  const expired = await webRegister();
  await prisma.session.update({ where: { id: expired.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const r2 = await refreshWith(expired.secret);
  assert.equal(r2.statusCode, 401);
  assert.equal(r2.raw, r1.raw, "revoked and expired are indistinguishable");
});

test("B9. no cookie, a malformed cookie, a duplicated cookie, or a body secret: all refused without a lookup's help", async () => {
  const { secret } = await webRegister();

  const none = await inject({ url: "/auth/web/refresh" });
  assert.equal(none.statusCode, 401);
  assert.deepEqual(none.body, CANONICAL_401);

  const malformed = await inject({ url: "/auth/web/refresh", cookie: `${COOKIE}=not a token!` });
  assert.equal(malformed.statusCode, 401);

  // Two cookies of our name (e.g. one tossed from a sibling host): ambiguous,
  // so neither is trusted.
  const duplicated = await inject({ url: "/auth/web/refresh", cookie: `${COOKIE}=${secret}; ${COOKIE}=${secret}` });
  assert.equal(duplicated.statusCode, 401, "an ambiguous credential is refused, never guessed at");

  // The cookie transport does not read a body secret.
  const body = await inject({ url: "/auth/web/refresh", payload: { refreshToken: secret } });
  assert.notEqual(body.statusCode, 200, "a secret in a body is not the cookie transport");
});

// ═════════════════════════════════════════════════════════════════════════════
// B10-B11. Logout
// ═════════════════════════════════════════════════════════════════════════════

test("B10. web logout revokes the SERVER session, clears the cookie, and kills every credential of that session", async () => {
  const { res: registered, secret, sessionId } = await webRegister();
  const identityToken = stringField(registered.body, "identityToken");

  const res = await inject({ url: "/auth/web/logout", cookie: `${COOKIE}=${secret}` });

  assert.equal(res.statusCode, 204);
  assert.equal(maxAgeOf(refreshCookieOf(res)), 0, "the browser is told to drop the cookie");
  const latest = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  assert.ok(latest.revokedAt !== null, "logout is server-side revocation, not just a local clear");

  assert.equal((await refreshWith(secret)).statusCode, 401, "the refresh cookie is dead");
  const me = await inject({ method: "GET", url: "/auth/me", token: identityToken });
  assert.equal(me.statusCode, 401, "and so is the in-memory access token");
});

test("B11. web logout with no cookie still answers 204 and clears; it cannot revoke a MOBILE session", async () => {
  const none = await inject({ url: "/auth/web/logout" });
  assert.equal(none.statusCode, 204);
  assert.equal(maxAgeOf(refreshCookieOf(none)), 0);

  const mobile = await inject({
    url: "/auth/register", origin: null,
    payload: { firstName: "Mo", lastName: "Bile", email: freshEmail(), password: PASSWORD },
  });
  const secret = stringField(mobile.body, "refreshToken");
  const res = await inject({ url: "/auth/web/logout", cookie: `${COOKIE}=${secret}` });
  assert.equal(res.statusCode, 204);
  const session = await prisma.session.findUniqueOrThrow({ where: { refreshTokenHash: digest(secret) } });
  assert.equal(session.revokedAt, null, "the cookie transport cannot act on a mobile session");
});

// ═════════════════════════════════════════════════════════════════════════════
// B12-B13. Origin: the CSRF baseline, on every cookie endpoint
// ═════════════════════════════════════════════════════════════════════════════

const HOSTILE_ORIGINS: (string | null)[] = [
  null,                                     // absent
  "null",                                   // opaque origin (sandboxed frame, file:)
  "https://evil.example.com",               // unlisted
  "https://app.allowed.example.com",        // a SIBLING subdomain
  "https://allowed.example.com.evil.com",   // a suffix trick
  "http://allowed.example.com",             // right host, wrong scheme
  "https://allowed.example.com:8443",       // right host, wrong port
  "https://ALLOWED.example.com/",           // not the exact serialised origin
];

test("B12. every cookie endpoint refuses an absent, opaque, unlisted, sibling or malformed Origin with the generic 403 — and does nothing", async () => {
  const { email, secret, sessionId } = await webRegister();
  const sessionsBefore = await prisma.session.count({ where: { user: { email } } });

  for (const origin of HOSTILE_ORIGINS) {
    const label = origin ?? "(absent)";
    const login = await inject({ url: "/auth/web/login", payload: { email, password: PASSWORD }, origin });
    assert.equal(login.statusCode, 403, `login from ${label}`);
    assert.deepEqual(login.body, CANONICAL_403);
    assert.equal(login.setCookies.length, 0, `no cookie for ${label}`);

    const register = await inject({ url: "/auth/web/register", origin, payload: { firstName: "X", lastName: "Y", email: freshEmail(), password: PASSWORD } });
    assert.equal(register.statusCode, 403, `register from ${label}`);

    const refresh = await refreshWith(secret, origin);
    assert.equal(refresh.statusCode, 403, `refresh from ${label}`);
    assert.equal(refresh.setCookies.length, 0);

    const logout = await inject({ url: "/auth/web/logout", cookie: `${COOKIE}=${secret}`, origin });
    assert.equal(logout.statusCode, 403, `logout from ${label}`);
  }

  assert.equal(await prisma.session.count({ where: { user: { email } } }), sessionsBefore, "no session was created");
  const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  assert.equal(session.refreshTokenHash, digest(secret), "nothing rotated");
  assert.equal(session.revokedAt, null, "nothing revoked");
  assert.equal(await prisma.user.count({ where: { email: { startsWith: TAG } } }), 1, "no account was created");

  // Positive control: the allowed origin, same secret, works.
  assert.equal((await refreshWith(secret)).statusCode, 200);
});

test("B13. the PHONE's endpoints do not require an Origin — they carry no cookie", async () => {
  const res = await inject({
    url: "/auth/register", origin: null,
    payload: { firstName: "Mo", lastName: "Bile", email: freshEmail(), password: PASSWORD },
  });
  assert.equal(res.statusCode, 201);
  const refreshed = await inject({ url: "/auth/refresh", origin: null, payload: { refreshToken: stringField(res.body, "refreshToken") } });
  assert.equal(refreshed.statusCode, 200);
});

// ═════════════════════════════════════════════════════════════════════════════
// B14. Credentialed CORS only where the cookie flow needs it
// ═════════════════════════════════════════════════════════════════════════════

test("B14. credentialed CORS is granted to the allowed origin on the cookie endpoints ONLY", async () => {
  const preflight = (url: string, origin: string): Promise<Injected> => inject({
    method: "OPTIONS", url, origin,
    headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });

  const web = await preflight("/auth/web/refresh", ORIGIN);
  assert.equal(web.headers["access-control-allow-origin"], ORIGIN);
  assert.equal(web.headers["access-control-allow-credentials"], "true", "the cookie flow needs credentialed CORS");

  const bearer = await preflight("/auth/me", ORIGIN);
  assert.equal(bearer.headers["access-control-allow-origin"], ORIGIN);
  assert.equal(bearer.headers["access-control-allow-credentials"], undefined, "bearer routes stay uncredentialed");

  for (const origin of ["https://evil.example.com", "https://app.allowed.example.com"]) {
    const foreign = await preflight("/auth/web/refresh", origin);
    assert.equal(foreign.headers["access-control-allow-origin"], undefined, `no CORS grant for ${origin}`);
    assert.equal(foreign.headers["access-control-allow-credentials"], undefined);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// B15. Tenant authority is unchanged: one membership auto-selects, from the row
// ═════════════════════════════════════════════════════════════════════════════

test("B15. web login with ONE active membership returns a tenant token minted from the row; the identity token reaches no tenant route", async () => {
  const { email } = await webRegister();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const company = await prisma.company.create({ data: { name: `${TAG}-co` } });
  await prisma.companyMembership.create({ data: { companyId: company.id, userId: user.id, role: "admin" } });

  const res = await inject({ url: "/auth/web/login", payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200);
  const tenant = stringField(res.body, "tenantToken");
  const claims = JSON.parse(Buffer.from(tenant.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(claims["companyId"], company.id);
  assert.equal("role" in claims, false, "no role authority in the JWT");

  const identity = stringField(res.body, "identityToken");
  const tenantRoute = await inject({ method: "GET", url: "/shifts/current", token: identity });
  assert.equal(tenantRoute.statusCode, 401, "an identity token never reaches tenant data");
  const withTenant = await inject({ method: "GET", url: "/shifts/current", token: tenant });
  assert.notEqual(withTenant.statusCode, 401, "the tenant token does");
});
