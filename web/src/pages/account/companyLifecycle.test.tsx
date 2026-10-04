import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { PATHS } from "../../paths";
import { account, installFakeApi, MEMBERSHIP, PENDING, type FakeApi } from "../../test/fakeApi";
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
    renderRoute(PATHS.account);
    fireEvent.click(await screen.findByRole("button", { name: "Send a new link" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/new link .*owner@example\.com/i);
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
    expect(next.getAttribute("href")).toBe(PATHS.account);
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
