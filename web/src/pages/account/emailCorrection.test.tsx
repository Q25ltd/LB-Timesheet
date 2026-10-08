import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { PATHS } from "../../paths";
import { account, installFakeApi, MEMBERSHIP, PENDING, type FakeApi } from "../../test/fakeApi";
import { renderRoute } from "../../test/renderRoute";

/**
 * An address that cannot receive mail (D56): the account is told, about its
 * OWN address only, and may correct it — re-proving its password. The server
 * decides whether a correction is allowed; the page offers it where the
 * server would: while a registration waits for its link, and whenever SES has
 * reported a problem with the address.
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

describe("Check your email, with a mistyped address", () => {
  test("offers to use a different address; correcting it sends ONLY the new address and the password, as THIS account", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    api.on("POST /auth/email/correction", { status: 204 });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Check your email" });

    fireEvent.click(screen.getByRole("button", { name: "Use a different email address" }));
    fireEvent.change(screen.getByLabelText("Correct email address"), { target: { value: "owner@example.org" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery-staple" } });
    api.on("GET /auth/me", { status: 200, body: account({ emailVerified: false, pendingCompanyRegistration: PENDING, email: "owner@example.org" }) });
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/new link .*owner@example\.org/i);
    const call = api.calls.find(c => c.path === "/auth/email/correction");
    expect(call?.body).toEqual({ email: "owner@example.org", currentPassword: "correct-horse-battery-staple" });
    expect(call?.authorization).toBe("Bearer header.identity.sig");
    expect(call?.credentials).toBe("omit");
    await waitFor(() => expect(main().textContent).toContain("owner@example.org"));
  });

  test("a wrong password, an address in use and an undeliverable address are each said plainly", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Check your email" });
    fireEvent.click(screen.getByRole("button", { name: "Use a different email address" }));
    fireEvent.change(screen.getByLabelText("Correct email address"), { target: { value: "owner@example.org" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });

    for (const [answer, said] of [
      [{ status: 403, body: { error: "Not allowed", code: "FORBIDDEN" } }, /password is incorrect/i],
      [{ status: 409, body: { error: "Email already registered", code: "EMAIL_IN_USE" } }, /already exists/i],
      [{ status: 409, body: { error: "Email cannot be delivered", code: "EMAIL_UNDELIVERABLE" } }, /cannot be delivered/i],
    ] as const) {
      api.on("POST /auth/email/correction", answer);
      fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(said));
    }
  });
});

describe("an address SES reported as undeliverable", () => {
  test("Check your email says the link could not be delivered, and opens the correction", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING, emailDeliveryProblem: "hard_bounce" });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Check your email" });
    expect(main().textContent).toMatch(/could not be delivered to owner@example\.com/i);
    expect(screen.getByLabelText("Correct email address")).toBeTruthy();
  });

  test("a resend to it is refused with the reason, not 'try again'", async () => {
    signedIn({ emailVerified: false, pendingCompanyRegistration: PENDING, emailDeliveryProblem: "hard_bounce" });
    api.on("POST /auth/email-verification", { status: 409, body: { error: "Email cannot be delivered", code: "EMAIL_UNDELIVERABLE" } });
    renderRoute(PATHS.account);
    fireEvent.click(await screen.findByRole("button", { name: "Send a new link" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be delivered.*correct/i);
  });

  test("a registered company's account page shows the problem and the correction; spam reports are named as such", async () => {
    signedIn({ memberships: [MEMBERSHIP], emailDeliveryProblem: "complaint" });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    const notice = screen.getByRole("region", { name: "Your email address" });
    expect(notice.textContent).toMatch(/reported .*as spam/i);
    expect(within(notice).getByLabelText("Correct email address")).toBeTruthy();
  });

  test("with nothing wrong, a registered company's account page offers no correction", async () => {
    signedIn({ memberships: [MEMBERSHIP] });
    renderRoute(PATHS.account);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(screen.queryByRole("region", { name: "Your email address" })).toBeNull();
    expect(screen.queryByLabelText("Correct email address")).toBeNull();
  });
});
