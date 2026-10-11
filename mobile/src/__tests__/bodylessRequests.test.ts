/**
 * F-38 — a request with no body must not claim a JSON one.
 *
 * The API (Fastify) refuses `Content-Type: application/json` with an empty
 * body: `400 FST_ERR_CTP_EMPTY_JSON_BODY`. The app sent that header on every
 * request, so every POST without a body was refused — sign-out's server
 * revocation since September (silently: its outcome was not acted on), and
 * D63's email confirmation, invitation acceptance and decline. Mocked
 * responses could not see it; `api/src/tests/db/mobileRequestShape.test.ts`
 * proves the same shapes against the real Fastify parser.
 *
 * The rule, as the website's client already keeps it: the header is sent
 * only when a JSON body is.
 */
import {
  acceptInvitation, declineInvitation, fetchAccount, fetchEmailVerification, listInvitations,
  logoutSession, refreshSession, requestEmailVerification, signIn,
} from "../api/account";

interface Sent { method: string; path: string; headers: Headers; body: unknown }

function capture(): Sent[] {
  const sent: Sent[] = [];
  jest.spyOn(global, "fetch").mockImplementation(((input: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", path: new URL(String(input)).pathname, headers: new Headers(init.headers), body: init.body });
    return Promise.resolve({ ok: true, status: 204, json: () => Promise.reject(new SyntaxError("no body")) } as Response);
  }) as unknown as typeof fetch);
  return sent;
}

afterEach(() => { jest.restoreAllMocks(); });

test.each([
  ["sign-out's server revocation", () => logoutSession("id.token"), "POST /auth/logout"],
  ["asking for the confirmation email (D63 stage 2)", () => requestEmailVerification("id.token"), "POST /auth/email-verification"],
  ["accepting an invitation (D63 stage 5)", () => acceptInvitation("id.token", "inv-1"), "POST /driver/invitations/inv-1/accept"],
  ["declining an invitation (D63 stage 5)", () => declineInvitation("id.token", "inv-1"), "POST /driver/invitations/inv-1/decline"],
  ["reading the account", () => fetchAccount("id.token"), "GET /auth/me"],
  ["reading the email status", () => fetchEmailVerification("id.token"), "GET /auth/me"],
  ["listing invitations", () => listInvitations("id.token"), "GET /driver/invitations"],
] as const)("BODYLESS — %s: no Content-Type and no body; the token and Accept still sent", async (_what, call, request) => {
  const sent = capture();

  await call();

  expect(sent).toHaveLength(1);
  const [first] = sent;
  expect(`${first?.method ?? ""} ${first?.path ?? ""}`).toBe(request);
  expect(first?.headers.has("content-type")).toBe(false);
  expect(first?.body).toBeUndefined();
  expect(first?.headers.get("authorization")).toBe("Bearer id.token");
  expect(first?.headers.get("accept")).toBe("application/json");
});

test.each([
  ["signing in", () => signIn({ email: "a@example.com", password: "correct-horse-battery-staple" }), "/auth/login"],
  ["renewing the session", () => refreshSession("secret-1"), "/auth/refresh"],
] as const)("WITH A BODY — %s: still JSON, with its Content-Type", async (_what, call, path) => {
  const sent = capture();

  await call();

  expect(sent[0]?.path).toBe(path);
  expect(sent[0]?.headers.get("content-type")).toBe("application/json");
  expect(typeof sent[0]?.body).toBe("string");
});
