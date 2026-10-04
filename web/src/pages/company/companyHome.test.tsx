import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { PATHS } from "../../paths";
import { account, installFakeApi, MEMBERSHIP, PENDING, type FakeApi } from "../../test/fakeApi";
import { renderRoute } from "../../test/renderRoute";

/**
 * The company workspace's Home (`/company`): the first page a company's
 * administrator reaches, inside the company application shell.
 *
 * It shows only what is REAL: the company the server validated (its name, from
 * the account's own membership), the one onboarding step that is done
 * (the company exists), and — said plainly as not available — what comes
 * next. No counts, no charts, no invented drivers or timesheets.
 *
 * The tenant context is the server's: a reload forgets it (D45), and with
 * exactly ONE membership the shell asks for it again through
 * `POST /auth/switch-company` — the D13 rule sign-in already applies. The
 * page sends a membership id, never a company id, and the server decides.
 */

const TENANT = "header.tenant.sig";
const BALTIC = { ...MEMBERSHIP, membershipId: "m-baltic", companyId: "c-baltic", companyName: "Baltic Reefer Lines" };

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

/** A browser signed in to a completed company registration, reloaded on `path`. */
function completedCompany(membership: typeof MEMBERSHIP = MEMBERSHIP) {
  api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
  api.on("GET /auth/me", { status: 200, body: account({ emailVerified: true, memberships: [membership] }) });
  api.on("POST /auth/switch-company", call => {
    const asked = call.body;
    const membershipId = typeof asked === "object" && asked !== null ? Reflect.get(asked, "membershipId") as unknown : undefined;
    return membershipId === membership.membershipId
      ? { status: 200, body: { tenantToken: TENANT, membership } }
      : { status: 403, body: { error: "Forbidden", code: "FORBIDDEN" } };
  });
}

async function home(name = MEMBERSHIP.companyName) {
  return screen.findByRole("heading", { level: 1, name });
}

function main(): HTMLElement {
  const element = document.querySelector("main");
  if (element === null) throw new Error("no <main>");
  return element;
}

function companyNav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Company" });
}

describe("who reaches Home", () => {
  test("1. a completed company reaches Home — after a reload the shell asks the server for its one membership", async () => {
    completedCompany();
    renderRoute(PATHS.company);
    await home();
    const switched = api.calls.filter(c => c.path === "/auth/switch-company");
    expect(switched).toHaveLength(1);
    expect(switched[0]?.body, "a membership is REQUESTED; no company id, no role").toEqual({ membershipId: MEMBERSHIP.membershipId });
    expect(switched[0]?.authorization).toBe("Bearer header.identity.sig");
  });

  test("1b. signing in with one company lands on Home", async () => {
    api.on("POST /auth/web/login", { status: 200, body: { user: account().user, identityToken: "header.identity.sig", tenantToken: TENANT, memberships: [MEMBERSHIP] } });
    api.on("GET /auth/me", { status: 200, body: account({ memberships: [MEMBERSHIP] }) });
    renderRoute(PATHS.login);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery-staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await home();
    expect(api.calls.some(c => c.path === "/auth/switch-company"), "sign-in already chose the one company").toBe(false);
  });

  test("2. the company's REAL name, as the server gave it, is the page's identity", async () => {
    completedCompany(BALTIC);
    const { router } = renderRoute(PATHS.company);
    await home("Baltic Reefer Lines");
    expect(router.state.location.pathname).toBe(PATHS.company);
    expect(main().textContent).not.toContain("Kuizinas Haulage Ltd");
    expect(document.title).toBe("Baltic Reefer Lines · LogisticBay Timesheets");
  });

  test("3. a PENDING registration does not reach Home — it is sent to Check your email", async () => {
    api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
    api.on("GET /auth/me", { status: 200, body: account({ emailVerified: false, pendingCompanyRegistration: PENDING }) });
    const { router } = renderRoute(PATHS.company);
    await screen.findByRole("heading", { level: 1, name: "Check your email" });
    expect(router.state.location.pathname).toBe(PATHS.account);
    expect(screen.queryByRole("navigation", { name: "Company" })).toBeNull();
    expect(api.calls.some(c => c.path === "/auth/switch-company")).toBe(false);
  });

  test("4. a signed-out visitor does not reach Home", async () => {
    renderRoute(PATHS.company);
    await screen.findByRole("heading", { level: 1, name: "Company sign-in" });
    expect(screen.queryByRole("navigation", { name: "Company" })).toBeNull();
  });

  test("an account holding several companies is not given one by guesswork — it chooses on its account page", async () => {
    api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
    api.on("GET /auth/me", { status: 200, body: account({ memberships: [MEMBERSHIP, BALTIC] }) });
    const { router } = renderRoute(PATHS.company);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(router.state.location.pathname).toBe(PATHS.account);
    expect(api.calls.some(c => c.path === "/auth/switch-company")).toBe(false);
  });

  test("7. only an ADMINISTRATOR membership opens the company workspace — a driver relationship never does", async () => {
    // The database never gives a company account a `driver` membership (D51),
    // and the API refuses one company-side authority; this is the browser not
    // presenting one as a workspace either.
    const DRIVER_MEMBERSHIP = { ...MEMBERSHIP, role: "driver" };
    api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
    api.on("GET /auth/me", { status: 200, body: account({ memberships: [DRIVER_MEMBERSHIP] }) });
    api.on("POST /auth/switch-company", { status: 200, body: { tenantToken: TENANT, membership: DRIVER_MEMBERSHIP } });
    const { router } = renderRoute(PATHS.company);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(router.state.location.pathname).toBe(PATHS.account);
    expect(api.calls.some(c => c.path === "/auth/switch-company")).toBe(false);
    expect(screen.queryByRole("navigation", { name: "Company" })).toBeNull();
  });

  test("7b. a selected company the server reports as a driver relationship is not shown as the workspace", async () => {
    const DRIVER_MEMBERSHIP = { ...MEMBERSHIP, role: "driver" };
    api.on("POST /auth/web/login", { status: 200, body: { user: account().user, identityToken: "header.identity.sig", tenantToken: TENANT, memberships: [DRIVER_MEMBERSHIP] } });
    api.on("GET /auth/me", { status: 200, body: account({ memberships: [DRIVER_MEMBERSHIP] }) });
    renderRoute(PATHS.login);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery-staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(screen.queryByRole("navigation", { name: "Company" })).toBeNull();
  });

  test("12. the server refusing the membership (revoked, or never this account's) shows no company at all", async () => {
    api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
    api.on("GET /auth/me", { status: 200, body: account({ memberships: [MEMBERSHIP] }) });
    api.on("POST /auth/switch-company", { status: 403, body: { error: "Forbidden", code: "FORBIDDEN" } });
    renderRoute(PATHS.company);
    await screen.findByRole("heading", { level: 1, name: "We could not open your company" });
    expect(screen.queryByRole("navigation", { name: "Company" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: MEMBERSHIP.companyName })).toBeNull();
  });

  test("12b. a same-email DRIVER's password is refused at company sign-in — the website never reaches a driver account", async () => {
    api.on("POST /auth/web/login", { status: 401, body: { error: "Invalid email or password", code: "INVALID_CREDENTIALS" } });
    renderRoute(PATHS.login);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "the-drivers-own-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Email or password is incorrect.");
    expect(screen.queryByRole("navigation", { name: "Company" })).toBeNull();
  });
});

describe("the company application shell", () => {
  test("5. the primary navigation is exactly Home, Drivers, Timesheets, Settings", async () => {
    completedCompany();
    renderRoute(PATHS.company);
    await home();
    const items = within(companyNav()).getAllByRole("listitem");
    expect(items.map(item => item.querySelector("[data-nav-label]")?.textContent)).toEqual(["Home", "Drivers", "Timesheets", "Settings"]);
  });

  test("6. Home is the current page, exposed to assistive technology", async () => {
    completedCompany();
    renderRoute(PATHS.company);
    await home();
    const current = within(companyNav()).getByRole("link", { current: "page" });
    expect(current.textContent).toContain("Home");
    expect(current.getAttribute("href")).toBe(PATHS.company);
  });

  test("9a. Drivers, Timesheets and Settings are NOT working controls: no link, no button, said to be not available", async () => {
    completedCompany();
    renderRoute(PATHS.company);
    await home();
    const nav = companyNav();
    expect(within(nav).getAllByRole("link").map(l => l.textContent)).toEqual(["Home"]);
    expect(within(nav).queryAllByRole("button")).toEqual([]);
    for (const name of ["Drivers", "Timesheets", "Settings"]) {
      const item = within(nav).getAllByRole("listitem").find(li => li.querySelector("[data-nav-label]")?.textContent === name);
      expect(item?.textContent, name).toMatch(/not available yet/i);
    }
  });

  test("11. sign-out is available, and signs out", async () => {
    completedCompany();
    api.on("POST /auth/web/logout", { status: 204 });
    renderRoute(PATHS.company);
    await home();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText("You have signed out.");
    expect(api.calls.some(c => c.path === "/auth/web/logout")).toBe(true);
  });

  test("names the administrator modestly and exposes no technical identifiers", async () => {
    completedCompany();
    renderRoute(PATHS.company);
    await home();
    const html = document.body.innerHTML;
    for (const technical of [MEMBERSHIP.membershipId, MEMBERSHIP.companyId, TENANT, "membershipId", "companyId", "accountKind", "sessionId"]) {
      expect(html, technical).not.toContain(technical);
    }
    expect(screen.getByText(/Nerijus Kuizinas/)).toBeTruthy();
  });
});

describe("Home for a new company", () => {
  function steps(): HTMLElement[] {
    const region = screen.getByRole("region", { name: /getting started/i });
    return within(within(region).getByRole("list")).getAllByRole("listitem");
  }

  test("7. onboarding: company created → first driver → the phone app → first timesheet", async () => {
    completedCompany();
    renderRoute(PATHS.company);
    await home();
    const titles = steps().map(step => step.querySelector("h3")?.textContent ?? "");
    expect(titles).toHaveLength(4);
    expect(titles[0]).toMatch(/company created/i);
    expect(titles[1]).toMatch(/add your first driver/i);
    expect(titles[2]).toMatch(/phone app/i);
    expect(titles[3]).toMatch(/first timesheet/i);
  });

  test("8. ONLY 'company created' is complete — said in words, not colour alone", async () => {
    completedCompany();
    renderRoute(PATHS.company);
    await home();
    const states = steps().map(step => step.getAttribute("data-state"));
    expect(states).toEqual(["done", "unavailable", "unavailable", "unavailable"]);
    const [first, ...rest] = steps();
    if (first === undefined) throw new Error("no steps");
    expect(within(first).getByText("Done")).toBeTruthy();
    for (const step of rest) {
      expect(within(step).getByText(/not available yet/i)).toBeTruthy();
      expect(within(step).queryByText(/^done$/i)).toBeNull();
    }
  });

  test("9b. future steps trigger nothing: no link or button in them, and the page asks the API for nothing more", async () => {
    completedCompany();
    renderRoute(PATHS.company);
    await home();
    for (const step of steps()) {
      expect(within(step).queryAllByRole("link")).toEqual([]);
      expect(within(step).queryAllByRole("button")).toEqual([]);
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    // The account is read, the one company requested, and the account re-read with it — nothing else.
    expect(api.calls.map(c => `${c.method} ${c.path}`)).toEqual(["POST /auth/web/refresh", "GET /auth/me", "POST /auth/switch-company", "GET /auth/me"]);
  });

  test("10. no fabricated statistics: no numbers, no charts, no tables in the page", async () => {
    completedCompany(BALTIC);
    renderRoute(PATHS.company);
    await home("Baltic Reefer Lines");
    expect(main().textContent ?? "", "no counts, hours, distances or money").not.toMatch(/\d/);
    expect(main().querySelector("canvas, table, progress, meter, [role='img']")).toBeNull();
    expect(main().textContent).not.toMatch(/£|\$|€|\bmiles?\b|\bkm\b|\blitres?\b|\bdefects? found\b/i);
  });

  test("the workspace's areas are described honestly, as not available yet", async () => {
    completedCompany();
    renderRoute(PATHS.company);
    await home();
    const guide = screen.getByRole("region", { name: /your workspace/i });
    for (const area of ["Drivers", "Timesheets", "Settings"]) expect(within(guide).getByRole("heading", { level: 3, name: area })).toBeTruthy();
    expect(within(guide).queryAllByRole("link")).toEqual([]);
    expect(within(guide).queryAllByRole("button")).toEqual([]);
  });
});

describe("arriving at Home", () => {
  test("Continue after a company registration's link leads to the company's Home", async () => {
    api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
    // As the server answers: pending until the link is confirmed, then the company.
    api.on("GET /auth/me", () => api.calls.some(c => c.path === "/auth/email-verification/confirm")
      ? { status: 200, body: account({ emailVerified: true, memberships: [MEMBERSHIP] }) }
      : { status: 200, body: account({ emailVerified: false, pendingCompanyRegistration: PENDING }) });
    api.on("POST /auth/email-verification/confirm", { status: 200, body: { companyRegistered: true } });
    renderRoute(`${PATHS.verifyEmail}#token=tok_ok`);
    await screen.findByRole("heading", { level: 1, name: "Your company is registered" });
    api.on("POST /auth/switch-company", { status: 200, body: { tenantToken: TENANT, membership: MEMBERSHIP } });
    const next = await screen.findByRole("link", { name: "Continue" });
    expect(next.getAttribute("href")).toBe(PATHS.company);
    fireEvent.click(next);
    await home();
    await waitFor(() => expect(within(companyNav()).getByRole("link", { current: "page" }).textContent).toContain("Home"));
  });
});
