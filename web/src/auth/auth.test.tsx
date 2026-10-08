import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PATHS } from "../paths";
import { account, installFakeApi, MEMBERSHIP, PENDING, type FakeApi } from "../test/fakeApi";
import { renderRoute } from "../test/renderRoute";

/**
 * The browser authentication client (D45, D46). What is proven here is the
 * CLIENT's discipline — where credentials live and how they travel. Who may
 * do what is the API's, proven in api/src/tests/db.
 */

const IDENTITY = "header.identity-token.signature";
const RENEWED = "header.renewed-identity-token.signature";
const TENANT = "header.tenant-token.signature";
const PASSWORD = "correct-horse-battery-staple";

let api: FakeApi;
const storageWrites: string[] = [];

beforeEach(() => {
  api = installFakeApi();
  storageWrites.length = 0;
  // Any attempt to persist anything in browser storage is recorded.
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(key => { storageWrites.push(`storage:${key}`); });
  // jsdom has no IndexedDB; any attempt to open one is recorded.
  vi.stubGlobal("indexedDB", {
    open(name: string) {
      storageWrites.push(`indexedDB:${name}`);
      throw new Error("no IndexedDB in this app");
    },
  });
  // A page-readable cookie write would shadow-record here; the HttpOnly
  // refresh cookie is the browser's, set by the API, and never passes this way.
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => "",
    set: (value: string) => { storageWrites.push(`cookie:${value}`); },
  });
});

afterEach(() => {
  Reflect.deleteProperty(document, "cookie");
});

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** A signed-in browser: the cookie refresh succeeds and /auth/me answers. */
function signedInApi(overrides: Parameters<typeof account>[0] = {}) {
  api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: IDENTITY } });
  api.on("GET /auth/me", { status: 200, body: account(overrides) });
}

describe("credentials: where they live and how they travel", () => {
  test("signing in sends exactly email and password to the COOKIE route, and persists nothing anywhere JavaScript can read", async () => {
    api.on("POST /auth/web/login", { status: 200, body: { user: account().user, identityToken: IDENTITY, memberships: [] } });
    api.on("GET /auth/me", { status: 200, body: account() });
    renderRoute(PATHS.login);

    fill("Email", "owner@example.com");
    fill("Password", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("heading", { level: 1, name: "Your account" });
    const login = api.calls.find(c => c.path === "/auth/web/login");
    expect(login?.credentials).toBe("include");
    expect(login?.body).toEqual({ email: "owner@example.com", password: PASSWORD });
    expect(storageWrites, "no token, secret or state may be persisted").toEqual([]);
    expect(document.body.innerHTML).not.toContain(IDENTITY);
  });

  test("ONLY /auth/web/* requests carry credentials; every other request omits them and uses the in-memory bearer token", async () => {
    signedInApi({ memberships: [MEMBERSHIP] });
    api.on("POST /auth/switch-company", { status: 200, body: { tenantToken: TENANT, membership: MEMBERSHIP } });
    renderRoute(PATHS.account);
    fireEvent.click(await screen.findByRole("button", { name: `Open ${MEMBERSHIP.companyName}` }));
    await screen.findByRole("heading", { level: 1, name: MEMBERSHIP.companyName });

    for (const call of api.calls) {
      if (call.path.startsWith("/auth/web/")) {
        expect(call.credentials, call.path).toBe("include");
        expect(call.authorization, `${call.path} never needs a bearer token`).toBeNull();
      } else {
        expect(call.credentials, call.path).toBe("omit");
        expect(call.authorization, call.path).toBe(`Bearer ${IDENTITY}`);
      }
    }
  });

  test("the company is chosen by REQUESTING a membership; the page sends no company id and no role", async () => {
    signedInApi({ memberships: [MEMBERSHIP] });
    api.on("POST /auth/switch-company", { status: 200, body: { tenantToken: TENANT, membership: MEMBERSHIP } });
    renderRoute(PATHS.account);
    fireEvent.click(await screen.findByRole("button", { name: `Open ${MEMBERSHIP.companyName}` }));
    await screen.findByRole("navigation", { name: "Company" });
    expect(api.calls.find(c => c.path === "/auth/switch-company")?.body).toEqual({ membershipId: MEMBERSHIP.membershipId });
  });
});

describe("session restore and expiry", () => {
  test("a reload restores the session through the cookie, then reads the account with the new in-memory token", async () => {
    signedInApi();
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(api.calls.map(c => `${c.method} ${c.path}`).slice(0, 2)).toEqual(["POST /auth/web/refresh", "GET /auth/me"]);
    expect(storageWrites).toEqual([]);
  });

  test("the homepage makes NO request — an anonymous visitor costs the API nothing", () => {
    renderRoute(PATHS.home);
    expect(api.calls).toEqual([]);
  });

  test("an account page with no session sends the visitor to sign in, showing no account content", async () => {
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Company sign-in" });
    expect(screen.queryByText("Your companies")).toBeNull();
  });

  test("an expired access token is renewed ONCE through the cookie and the request retried", async () => {
    api.on("POST /auth/web/refresh", (() => {
      let n = 0;
      return () => ({ status: 200, body: { identityToken: (n += 1) === 1 ? IDENTITY : RENEWED } });
    })());
    api.on("GET /auth/me", call => call.authorization === `Bearer ${IDENTITY}`
      ? { status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } }
      : { status: 200, body: account() });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(api.calls.filter(c => c.path === "/auth/web/refresh")).toHaveLength(2);
  });

  test("a revoked session (refresh refused) ends in signed-out, not a loop", async () => {
    api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: IDENTITY } });
    api.on("GET /auth/me", { status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } });
    renderRoute(PATHS.account);
    // The second refresh (after /auth/me's 401) is the unscripted canonical 401.
    api.on("POST /auth/web/refresh", { status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } });
    await screen.findByRole("heading", { level: 1, name: "Company sign-in" });
    expect(api.calls.length).toBeLessThan(6);
  });

  // A server FAULT is not a verdict on the session. The API leaves the cookie
  // alone on a 5xx (api/src/tests/db/refreshOutage.test.ts); the page must not
  // then declare the visitor signed out and send them to sign in.
  test("a server fault while restoring shows 'could not reach', not the sign-in page", async () => {
    api.on("POST /auth/web/refresh", { status: 500, body: { error: "Internal server error" } });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "We could not reach LogisticBay Timesheets" });
    expect(screen.queryByRole("heading", { level: 1, name: "Company sign-in" })).toBeNull();
  });

  // Found serving the production build against an API that did not answer:
  // each 'could not reach' changed the auth state, which re-ran the page's
  // restore, which failed again — hundreds of refreshes a second from every
  // open browser, all aimed at an API that was already down.
  test("an API that cannot be reached is asked ONCE — not again and again while the page waits", async () => {
    api.on("POST /auth/web/refresh", () => "offline");
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "We could not reach LogisticBay Timesheets" });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(api.calls.filter(c => c.path === "/auth/web/refresh")).toHaveLength(1);
  });

  test("after a pause, moving to another page asks again — and a recovered API restores the session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      api.on("POST /auth/web/refresh", () => "offline");
      const { router } = renderRoute(PATHS.account);
      await screen.findByRole("heading", { level: 1, name: "We could not reach LogisticBay Timesheets" });

      vi.setSystemTime(Date.now() + 15_000);
      signedInApi();
      await router.navigate(PATHS.company);
      await waitFor(() => expect(api.calls.filter(c => c.path === "/auth/web/refresh")).toHaveLength(2));
      await screen.findByRole("heading", { level: 1, name: "Your account" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a server fault reading the account after a good restore is 'could not reach' too", async () => {
    api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: IDENTITY } });
    api.on("GET /auth/me", { status: 503, body: { error: "Unavailable" } });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "We could not reach LogisticBay Timesheets" });
  });

  test("a server fault while RENEWING mid-session keeps the person signed in and reports the failure", async () => {
    signedInApi({ emailVerified: false });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    // The access token has expired, and the renewal hits a fault.
    api.on("POST /auth/email-verification", { status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } });
    api.on("POST /auth/web/refresh", { status: 500, body: { error: "Internal server error" } });
    fireEvent.click(screen.getByRole("button", { name: "Send a new confirmation link" }));
    await waitFor(() => expect(api.calls.filter(c => c.path === "/auth/web/refresh").length).toBeGreaterThan(1));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Your account" })).toBeTruthy();
  });

  test("a REFUSED renewal mid-session still signs out — a revoked session must not linger", async () => {
    signedInApi({ emailVerified: false });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    api.on("POST /auth/email-verification", { status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } });
    api.on("POST /auth/web/refresh", { status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } });
    fireEvent.click(screen.getByRole("button", { name: "Send a new confirmation link" }));
    await screen.findByRole("heading", { level: 1, name: "Company sign-in" });
  });

  test("with the Web Locks API present, refreshes are serialised across tabs under one lock", async () => {
    const request = vi.fn((_name: string, task: () => Promise<unknown>) => task());
    vi.stubGlobal("navigator", { ...navigator, locks: { request } });
    signedInApi();
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(request).toHaveBeenCalledWith("lbts-refresh", expect.any(Function));
  });
});

describe("sign out", () => {
  test("revokes the server session through the cookie route, then forgets everything", async () => {
    signedInApi();
    api.on("POST /auth/web/logout", { status: 204 });
    renderRoute(PATHS.account);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByText("You have signed out.");
    const logout = api.calls.find(c => c.path === "/auth/web/logout");
    expect(logout?.credentials).toBe("include");
  });

  test("with no network it still signs out HERE, and says truthfully that the server was not reached", async () => {
    signedInApi();
    api.on("POST /auth/web/logout", () => "offline");
    renderRoute(PATHS.account);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByText("You are signed out on this device, but we could not reach the server to end the session.");
    expect(screen.queryByText("You have signed out.")).toBeNull();
  });
});

describe("registration and the emailed links", () => {
  test("the company registration form holds the administrator's password to the rule, then registers through the cookie route and persists nothing readable", async () => {
    api.on("POST /auth/web/register", { status: 201, body: { user: { id: "u-1", firstName: "Nerijus", lastName: "Kuizinas", email: "owner@example.com" }, identityToken: IDENTITY, memberships: [] } });
    api.on("GET /auth/me", { status: 200, body: account({ emailVerified: false, pendingCompanyRegistration: PENDING }) });
    renderRoute(PATHS.register);
    fill("Company name", "Kuizinas Haulage Ltd");
    // Chosen, as a company does — never left to whatever zone the machine
    // running the test is in (D53).
    fill("Time zone", "Europe/Vilnius");
    fill("First name", "Nerijus");
    fill("Last name", "Kuizinas");
    fill("Email", "owner@example.com");
    fill("Password", "short");
    fill("Repeat password", "short");
    fireEvent.click(screen.getByRole("button", { name: "Register company" }));
    expect(await screen.findByText("At least 10 characters", { selector: ".field__error" })).toBeTruthy();
    expect(api.calls.some(c => c.path === "/auth/web/register"), "an invalid form sends nothing").toBe(false);

    fill("Password", PASSWORD);
    fill("Repeat password", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Register company" }));
    await screen.findByRole("heading", { level: 1, name: "Check your email" });
    const registration = api.calls.find(c => c.path === "/auth/web/register");
    expect(registration?.credentials).toBe("include");
    expect(registration?.authorization).toBeNull();
    expect(storageWrites).toEqual([]);
  });

  test("the verification link's token is read from the FRAGMENT, posted once, and removed from the address", async () => {
    api.on("POST /auth/email-verification/confirm", { status: 200, body: { companyRegistered: false } });
    const { router } = renderRoute(`${PATHS.verifyEmail}#token=abc123_-XYZ`);
    await screen.findByRole("heading", { level: 1, name: "Your email address is confirmed" });
    const confirms = api.calls.filter(c => c.path === "/auth/email-verification/confirm");
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.body).toEqual({ token: "abc123_-XYZ" });
    expect(confirms[0]?.credentials).toBe("omit");
    await waitFor(() => expect(router.state.location.hash).toBe(""));
  });

  test("a reset link sets a new password with its token, and says every device is signed out", async () => {
    api.on("POST /auth/password/reset", { status: 204 });
    renderRoute(`${PATHS.resetPassword}#token=tok_123`);
    fill("New password", "a-brand-new-passphrase");
    fill("Repeat new password", "a-brand-new-passphrase");
    fireEvent.click(await screen.findByRole("button", { name: "Save new password" }));
    await screen.findByRole("heading", { level: 1, name: "Your password has been changed" });
    expect(api.calls.find(c => c.path === "/auth/password/reset")?.body).toEqual({ token: "tok_123", password: "a-brand-new-passphrase" });
  });

  test("forgot password shows the same message whatever the API knows", async () => {
    api.on("POST /auth/password/forgot", { status: 204 });
    renderRoute(PATHS.forgotPassword);
    fill("Email", "anyone@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await screen.findByText("If that address has an account, a reset link is on its way. It works once and expires in 30 minutes.");
  });
});
