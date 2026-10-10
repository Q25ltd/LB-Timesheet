import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PATHS } from "../../paths";
import { account, holdDevelopmentEmailLookup, installFakeApi, MEMBERSHIP, PENDING, type FakeApi } from "../../test/fakeApi";
import { renderRoute } from "../../test/renderRoute";

/**
 * The company's states on the website after it registers (D51):
 *
 *   PENDING   signed in, restricted: "Check your email" — the company being
 *             registered, the address to confirm, a resend; nothing else
 *   COMPANY   the email confirmed and the company created: the account and
 *             its company
 *   NEITHER   an account with no company and no registration — said plainly;
 *             nothing here can create a company (the old person-first
 *             "Set up a company" is gone)
 *
 * And the emailed link's outcomes on /verify-email.
 */

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function signedIn(overrides: Parameters<typeof account>[0]) {
  api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
  api.on("GET /auth/me", { status: 200, body: account(overrides) });
}

function main(): HTMLElement {
  const element = document.querySelector("main");
  if (element === null) throw new Error("no <main>");
  return element;
}

describe("a pending company registration: Check your email", () => {
  test("names the company being registered and the address to confirm — and offers nothing else", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Check your email" });
    const text = main().textContent ?? "";
    expect(text).toContain("Kuizinas Haulage Ltd");
    expect(text).toContain("owner@example.com");
    expect(text).not.toMatch(/set up a company|your companies|change password/i);
    expect(screen.queryByLabelText("Company name")).toBeNull();
  });

  test("the resend asks for a new link for THIS account, and says when it is sent", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    api.on("POST /auth/email-verification", { status: 204 });
    holdDevelopmentEmailLookup();
    renderRoute(PATHS.account);
    fireEvent.click(await screen.findByRole("button", { name: "Send a new link" }));
    // Its own confirmation — announced politely, as a status.
    const sent = await screen.findByText(/new link .*owner@example\.com/i);
    expect(sent.getAttribute("role")).toBe("status");
    const resend = api.calls.find(c => c.path === "/auth/email-verification");
    expect(resend?.body).toBeNull();
    expect(resend?.authorization).toBe("Bearer header.identity.sig");
  });

  test("a resend refused for too many requests says so", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    api.on("POST /auth/email-verification", { status: 429, body: { error: "Too many requests, try again shortly", code: "RATE_LIMITED" } });
    renderRoute(PATHS.account);
    fireEvent.click(await screen.findByRole("button", { name: "Send a new link" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/too many/i);
  });

  test("can sign out", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    api.on("POST /auth/web/logout", { status: 204 });
    renderRoute(PATHS.account);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByText("You have signed out.");
  });
});

describe("in DEVELOPMENT: the outbox's link, on the page", () => {
  const firstLink = () => `${window.location.origin}/verify-email#token=dev_first_token`;
  const secondLink = () => `${window.location.origin}/verify-email#token=dev_second_token`;

  test("Check your email hands over the EXACT link the outbox received, asked for as THIS account", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    api.on("GET /dev/email-verification-link", { status: 200, body: { link: firstLink() } });
    renderRoute(PATHS.account);
    const region = await screen.findByRole("region", { name: "Development email" });
    const open = await within(region).findByRole("link", { name: "Open verification link" });
    expect(open.getAttribute("href")).toBe(firstLink());
    const asked = api.calls.find(c => c.path === "/dev/email-verification-link");
    expect(asked?.authorization).toBe("Bearer header.identity.sig");
    expect(asked?.credentials).toBe("omit");
  });

  test("after Send a new link, the NEW link replaces the old one on the page", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    api.on("GET /dev/email-verification-link", { status: 200, body: { link: firstLink() } });
    api.on("POST /auth/email-verification", { status: 204 });
    renderRoute(PATHS.account);
    await screen.findByRole("link", { name: "Open verification link" });

    api.on("GET /dev/email-verification-link", { status: 200, body: { link: secondLink() } });
    fireEvent.click(screen.getByRole("button", { name: "Send a new link" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Open verification link" }).getAttribute("href")).toBe(secondLink()));
    expect(main().innerHTML).not.toContain("dev_first_token");
    expect(api.calls.filter(c => c.path === "/dev/email-verification-link"), "once on arrival, once after the resend").toHaveLength(2);
  });

  test("with no message in the outbox, it says so and points at Send a new link", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    api.on("GET /dev/email-verification-link", { status: 404, body: { error: "No verification email in the development outbox", code: "NOT_FOUND" } });
    renderRoute(PATHS.account);
    const region = await screen.findByRole("region", { name: "Development email" });
    expect(await within(region).findByText(/no verification email .*send a new link/i)).toBeTruthy();
    expect(within(region).queryByRole("link", { name: "Open verification link" })).toBeNull();
  });

  test("a link that is not this site's verification page is never offered", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    api.on("GET /dev/email-verification-link", { status: 200, body: { link: "https://elsewhere.example.com/verify-email#token=x" } });
    renderRoute(PATHS.account);
    await screen.findByRole("region", { name: "Development email" });
    await waitFor(() => expect(api.calls.some(c => c.path === "/dev/email-verification-link")).toBe(true));
    expect(screen.queryByRole("link", { name: "Open verification link" })).toBeNull();
  });
});

describe("in a PRODUCTION build", () => {
  test("Check your email neither asks for nor shows any development email", async () => {
    vi.stubEnv("DEV", false);
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Check your email" });
    expect(screen.queryByRole("region", { name: "Development email" })).toBeNull();
    expect(main().textContent).not.toMatch(/development|mail-outbox/i);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(api.calls.some(c => c.path.startsWith("/dev/"))).toBe(false);
  });
});

describe("a registered company", () => {
  test("shows its company to open — and no 'Set up a company' anywhere", async () => {
    signedIn({ emailVerified: true, memberships: [MEMBERSHIP] });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(screen.getByRole("button", { name: "Open Kuizinas Haulage Ltd" })).toBeTruthy();
    expect(main().textContent).not.toMatch(/set up a company|check your email/i);
    expect(screen.queryByLabelText("Company name")).toBeNull();
  });
});

describe("an account with no company and no registration", () => {
  test("is told so plainly, with nothing that creates a company", async () => {
    signedIn({ emailVerified: true });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(main().textContent).toMatch(/no company/i);
    expect(screen.queryByLabelText("Company name")).toBeNull();
    expect(main().textContent).not.toMatch(/set up a company/i);
  });
});

describe("the emailed link", () => {
  test("completing a company registration says so, and leads a signed-out visitor to sign in", async () => {
    api.on("POST /auth/email-verification/confirm", { status: 200, body: { companyRegistered: true } });
    renderRoute(`${PATHS.verifyEmail}#token=tok_ok`);
    await screen.findByRole("heading", { level: 1, name: "Your company is registered" });
    expect(within(main()).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(PATHS.login);
  });

  test("in the browser still signed in to the registration, it continues to the company", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    api.on("POST /auth/email-verification/confirm", { status: 200, body: { companyRegistered: true } });
    renderRoute(`${PATHS.verifyEmail}#token=tok_ok`);
    await screen.findByRole("heading", { level: 1, name: "Your company is registered" });
    api.on("GET /auth/me", { status: 200, body: account({ emailVerified: true, memberships: [MEMBERSHIP] }) });
    const next = await screen.findByRole("link", { name: "Continue" });
    expect(next.getAttribute("href")).toBe(PATHS.company);
  });

  test("a link that only confirms an email says only that", async () => {
    api.on("POST /auth/email-verification/confirm", { status: 200, body: { companyRegistered: false } });
    renderRoute(`${PATHS.verifyEmail}#token=tok_ok`);
    await screen.findByRole("heading", { level: 1, name: "Your email address is confirmed" });
  });

  test("an invalid, used or expired link is one honest message, pointing at a new link", async () => {
    api.on("POST /auth/email-verification/confirm", { status: 400, body: { error: "This link is invalid or has expired", code: "TOKEN_INVALID" } });
    renderRoute(`${PATHS.verifyEmail}#token=tok_old`);
    await screen.findByRole("heading", { level: 1, name: "This link has expired or was already used" });
    expect(main().textContent).toMatch(/sign in .*new link/i);
  });

  test("a server failure is not called an invalid link — and says nothing was lost", async () => {
    api.on("POST /auth/email-verification/confirm", { status: 503, body: { error: "Unavailable" } });
    renderRoute(`${PATHS.verifyEmail}#token=tok_ok`);
    await screen.findByRole("heading", { level: 1, name: "We could not confirm your email just now" });
    expect(main().textContent).toMatch(/open the link again/i);
  });

  test("the link is used ONCE and taken out of the address bar", async () => {
    api.on("POST /auth/email-verification/confirm", { status: 200, body: { companyRegistered: true } });
    const { router } = renderRoute(`${PATHS.verifyEmail}#token=abc123_-XYZ`);
    await screen.findByRole("heading", { level: 1, name: "Your company is registered" });
    const confirms = api.calls.filter(c => c.path === "/auth/email-verification/confirm");
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.body).toEqual({ token: "abc123_-XYZ" });
    expect(confirms[0]?.credentials).toBe("omit");
    await waitFor(() => expect(router.state.location.hash).toBe(""));
  });
});
