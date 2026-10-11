import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { PATHS } from "../../paths";
import { account, installFakeApi, MEMBERSHIP, type FakeApi } from "../../test/fakeApi";
import { renderRoute } from "../../test/renderRoute";

/**
 * D63, stage 4 — the company website's Drivers page (`/company/drivers`).
 *
 * The company adds a driver by name and email (and its own payroll
 * reference), and sees where each invitation stands: Invited, Joined,
 * Declined, Expired or Cancelled. It can correct or cancel one that is still
 * open. Nothing here looks a driver up: the page shows only what the company
 * typed and what the driver answered (D63).
 *
 * Every call is the company's: its TENANT token, in memory, never a cookie.
 * An expired tenant token is renewed once — by asking the server for the
 * company again (switch-company) — and the call retried.
 */

const TENANT = "header.tenant.sig";
const RENEWED = "header.tenant.renewed";
const LIST = "/company/driver-invitations";

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

function invitation(over: Record<string, unknown> = {}) {
  return {
    id: "inv-1", firstName: "John", lastName: "Smith", email: "john@example.com", payrollRef: "EMP-1",
    status: "pending", createdAt: "2026-10-11T08:00:00.000Z", expiresAt: "2026-11-10T08:00:00.000Z", ...over,
  };
}

/** A browser signed in to a company with one admin membership, reloaded on `path`. */
function companyAdmin(invitations: unknown[] = []) {
  api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
  api.on("GET /auth/me", { status: 200, body: account({ emailVerified: true, memberships: [MEMBERSHIP] }) });
  api.on("POST /auth/switch-company", { status: 200, body: { tenantToken: TENANT, membership: MEMBERSHIP } });
  api.on(`GET ${LIST}`, () => ({ status: 200, body: { invitations } }));
}

async function driversPage() {
  renderRoute("/company/drivers");
  return screen.findByRole("heading", { level: 1, name: "Drivers" });
}

function main(): HTMLElement {
  const element = document.querySelector("main");
  if (element === null) throw new Error("no <main>");
  return element;
}

function row(name: string): HTMLElement {
  const found = within(screen.getByRole("table", { name: "Your drivers" })).getAllByRole("row").find(r => r.textContent?.includes(name) === true);
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

function fill(fields: Record<string, string>) {
  for (const [label, value] of Object.entries(fields)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("reaching Drivers", () => {
  test("DP1. Drivers is now a real place: a link in the company navigation, current on its page; Timesheets and Settings are still not available", async () => {
    companyAdmin();
    await driversPage();
    const nav = screen.getByRole("navigation", { name: "Company" });
    const drivers = within(nav).getByRole("link", { name: /Drivers/ });
    expect(drivers.getAttribute("href")).toBe("/company/drivers");
    expect(drivers.getAttribute("aria-current")).toBe("page");
    expect(within(nav).getAllByRole("link").map(l => l.textContent)).toEqual(["Home", "Drivers"]);
    for (const name of ["Timesheets", "Settings"]) {
      const item = within(nav).getAllByRole("listitem").find(li => li.querySelector("[data-nav-label]")?.textContent === name);
      expect(item?.textContent, name).toMatch(/not available yet/i);
    }
  });

  test("DP2. the list is asked for with the COMPANY's token, in memory — never a cookie", async () => {
    companyAdmin([invitation()]);
    await driversPage();
    await waitFor(() => { expect(row("John Smith")).toBeTruthy(); });
    const asked = api.calls.filter(c => c.path === LIST);
    expect(asked[0]?.authorization).toBe(`Bearer ${TENANT}`);
    expect(asked[0]?.credentials).toBe("omit");
  });
});

describe("the list", () => {
  test("DP3. each driver as the company typed them, and where their invitation stands — in plain words", async () => {
    companyAdmin([
      invitation({ id: "a", firstName: "Ann", lastName: "Invited", status: "pending" }),
      invitation({ id: "b", firstName: "Ben", lastName: "Joined", status: "accepted", payrollRef: null }),
      invitation({ id: "c", firstName: "Cal", lastName: "Declined", status: "declined" }),
      invitation({ id: "d", firstName: "Dan", lastName: "Expired", status: "expired" }),
      invitation({ id: "e", firstName: "Eve", lastName: "Cancelled", status: "cancelled" }),
    ]);
    await driversPage();
    await waitFor(() => { expect(row("Ann Invited")).toBeTruthy(); });
    expect(row("Ann Invited").textContent).toMatch(/Invited/);
    expect(row("Ann Invited").textContent).toContain("john@example.com");
    expect(row("Ann Invited").textContent).toContain("EMP-1");
    expect(row("Ben Joined").textContent).toMatch(/Joined/);
    expect(row("Cal Declined").textContent).toMatch(/Declined/);
    expect(row("Dan Expired").textContent).toMatch(/Expired/);
    expect(row("Eve Cancelled").textContent).toMatch(/Cancelled/);
  });

  test("DP4. only an open invitation can be corrected or cancelled", async () => {
    companyAdmin([
      invitation({ id: "a", firstName: "Ann", lastName: "Invited", status: "pending" }),
      invitation({ id: "b", firstName: "Ben", lastName: "Joined", status: "accepted" }),
      invitation({ id: "c", firstName: "Cal", lastName: "Declined", status: "declined" }),
    ]);
    await driversPage();
    await waitFor(() => { expect(row("Ann Invited")).toBeTruthy(); });
    expect(within(row("Ann Invited")).getByRole("button", { name: /Edit/ })).toBeTruthy();
    expect(within(row("Ann Invited")).getByRole("button", { name: /Cancel invitation/ })).toBeTruthy();
    for (const name of ["Ben Joined", "Cal Declined"]) expect(within(row(name)).queryAllByRole("button")).toEqual([]);
  });

  test("DP5. with no drivers yet, it says so and says how to begin", async () => {
    companyAdmin([]);
    await driversPage();
    await waitFor(() => { expect(main().textContent).toMatch(/no drivers yet/i); });
    expect(screen.queryByRole("table", { name: "Your drivers" })).toBeNull();
  });

  test("DP6. a list that could not be loaded says so — it never shows an empty company", async () => {
    companyAdmin();
    api.on(`GET ${LIST}`, { status: 503, body: { error: "Unavailable" } });
    await driversPage();
    await waitFor(() => { expect(main().textContent).toMatch(/could not load your drivers/i); });
    expect(main().textContent).not.toMatch(/no drivers yet/i);
  });
  test("DP17. an answer the page does not understand — an unknown status — is not drawn as drivers; it says the list could not be loaded", async () => {
    companyAdmin([invitation({ status: "approved" })]);
    await driversPage();
    await waitFor(() => { expect(main().textContent).toMatch(/could not load your drivers/i); });
    expect(screen.queryByRole("table", { name: "Your drivers" })).toBeNull();
  });
});

describe("adding a driver", () => {
  test("DP7. adding sends exactly what was typed — and is said to be an invitation the driver accepts in the app, never that they joined", async () => {
    const created = invitation({ id: "new", firstName: "Nia", lastName: "New", email: "nia@example.com", payrollRef: "P-9" });
    let invitations: unknown[] = [];
    companyAdmin();
    api.on(`GET ${LIST}`, () => ({ status: 200, body: { invitations } }));
    api.on(`POST ${LIST}`, () => { invitations = [created]; return { status: 201, body: { invitation: created } }; });
    await driversPage();

    fill({ "First name": " Nia ", "Last name": "New", "Email address": "nia@example.com", "Payroll or employee reference (optional)": "P-9" });
    fireEvent.click(screen.getByRole("button", { name: "Add driver" }));

    await waitFor(() => { expect(screen.getByRole("status").textContent).toMatch(/invited Nia New/i); });
    expect(screen.getByRole("status").textContent).toMatch(/LogisticBay Timesheets app/i);
    const sent = api.calls.find(c => c.method === "POST" && c.path === LIST);
    expect(sent?.body).toEqual({ firstName: "Nia", lastName: "New", email: "nia@example.com", payrollRef: "P-9" });
    expect(sent?.authorization).toBe(`Bearer ${TENANT}`);
    await waitFor(() => { expect(row("Nia New").textContent).toMatch(/Invited/); });
    expect(screen.getByLabelText<HTMLInputElement>("First name").value, "the form is ready for the next driver").toBe("");
  });

  test("DP8. a blank payroll reference is simply not sent", async () => {
    companyAdmin();
    api.on(`POST ${LIST}`, { status: 201, body: { invitation: invitation({ payrollRef: null }) } });
    await driversPage();
    fill({ "First name": "John", "Last name": "Smith", "Email address": "john@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Add driver" }));
    await waitFor(() => { expect(api.calls.some(c => c.method === "POST" && c.path === LIST)).toBe(true); });
    expect(api.calls.find(c => c.method === "POST" && c.path === LIST)?.body).toEqual({ firstName: "John", lastName: "Smith", email: "john@example.com" });
  });

  test("DP9. missing names or a malformed address are caught on the page — nothing is sent", async () => {
    companyAdmin();
    await driversPage();
    fill({ "First name": "", "Last name": "Smith", "Email address": "not-an-email" });
    fireEvent.click(screen.getByRole("button", { name: "Add driver" }));
    await waitFor(() => { expect(main().textContent).toMatch(/enter the driver's first name/i); });
    expect(main().textContent).toMatch(/enter a valid email address/i);
    expect(api.calls.some(c => c.method === "POST" && c.path === LIST)).toBe(false);
  });

  test("DP10. every refusal is said plainly, and what was typed is kept", async () => {
    const cases: [object, RegExp][] = [
      [{ status: 409, body: { error: "x", code: "ALREADY_A_DRIVER" } }, /already one of your drivers/i],
      [{ status: 409, body: { error: "x", code: "INVITATION_EXISTS" } }, /already has an open invitation/i],
      [{ status: 429, body: { error: "x", code: "INVITATION_LIMIT" } }, /most drivers allowed in one day/i],
      [{ status: 503, body: { error: "x" } }, /could not add the driver/i],
    ];
    for (const [answer, said] of cases) {
      document.body.innerHTML = "";
      api = installFakeApi();
      companyAdmin();
      api.on(`POST ${LIST}`, answer as { status: number; body?: unknown });
      await driversPage();
      fill({ "First name": "John", "Last name": "Smith", "Email address": "john@example.com" });
      fireEvent.click(screen.getByRole("button", { name: "Add driver" }));
      await waitFor(() => { expect(screen.getByRole("alert").textContent).toMatch(said); });
      expect(screen.getByLabelText<HTMLInputElement>("Email address").value).toBe("john@example.com");
    }
  });
});

describe("correcting and cancelling", () => {
  test("DP11. Edit corrects the names and payroll reference of an open invitation — never its address", async () => {
    let current = invitation();
    companyAdmin();
    api.on(`GET ${LIST}`, () => ({ status: 200, body: { invitations: [current] } }));
    api.on(`PATCH ${LIST}/inv-1`, call => {
      current = { ...current, ...(call.body as object) };
      return { status: 200, body: { invitation: current } };
    });
    await driversPage();
    await waitFor(() => { expect(row("John Smith")).toBeTruthy(); });

    fireEvent.click(within(row("John Smith")).getByRole("button", { name: /Edit/ }));
    expect(screen.queryByLabelText("Edit email address")).toBeNull();
    fireEvent.change(screen.getByLabelText("Edit first name"), { target: { value: "Jon" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => { expect(row("Jon Smith")).toBeTruthy(); });
    const patch = api.calls.find(c => c.method === "PATCH");
    expect(patch?.body).toEqual({ firstName: "Jon", lastName: "Smith", payrollRef: "EMP-1" });
    expect(patch?.authorization).toBe(`Bearer ${TENANT}`);
  });

  test("DP12. Cancel asks first; confirming cancels, and the row says Cancelled", async () => {
    let current = invitation();
    companyAdmin();
    api.on(`GET ${LIST}`, () => ({ status: 200, body: { invitations: [current] } }));
    api.on(`POST ${LIST}/inv-1/cancel`, () => { current = { ...current, status: "cancelled" }; return { status: 200, body: { invitation: current } }; });
    await driversPage();
    await waitFor(() => { expect(row("John Smith")).toBeTruthy(); });

    fireEvent.click(within(row("John Smith")).getByRole("button", { name: /Cancel invitation/ }));
    expect(api.calls.some(c => c.path.endsWith("/cancel")), "one click asks; it does not cancel").toBe(false);
    fireEvent.click(within(row("John Smith")).getByRole("button", { name: /Yes, cancel/ }));

    await waitFor(() => { expect(row("John Smith").textContent).toMatch(/Cancelled/); });
    expect(api.calls.filter(c => c.path.endsWith("/cancel"))).toHaveLength(1);
  });

  test("DP13. an invitation the driver answered meanwhile cannot be changed — the page says so and shows where it now stands", async () => {
    let current = invitation();
    companyAdmin();
    api.on(`GET ${LIST}`, () => ({ status: 200, body: { invitations: [current] } }));
    api.on(`POST ${LIST}/inv-1/cancel`, () => { current = { ...current, status: "accepted" }; return { status: 409, body: { error: "x", code: "INVITATION_NOT_PENDING" } }; });
    await driversPage();
    await waitFor(() => { expect(row("John Smith")).toBeTruthy(); });
    fireEvent.click(within(row("John Smith")).getByRole("button", { name: /Cancel invitation/ }));
    fireEvent.click(within(row("John Smith")).getByRole("button", { name: /Yes, cancel/ }));

    await waitFor(() => { expect(screen.getByRole("alert").textContent).toMatch(/no longer open/i); });
    await waitFor(() => { expect(row("John Smith").textContent).toMatch(/Joined/); });
  });
});

describe("the company's token", () => {
  test("DP14. an expired company token is renewed ONCE — the server asked for the company again — and the list still loads", async () => {
    companyAdmin([invitation()]);
    // The first selection (the reload) issues TENANT; any later one, RENEWED.
    let selections = 0;
    api.on("POST /auth/switch-company", () => {
      selections += 1;
      return { status: 200, body: { tenantToken: selections === 1 ? TENANT : RENEWED, membership: MEMBERSHIP } };
    });
    api.on(`GET ${LIST}`, call => (call.authorization === `Bearer ${RENEWED}`
      ? { status: 200, body: { invitations: [invitation()] } }
      : { status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } }));
    await driversPage();

    await waitFor(() => { expect(row("John Smith")).toBeTruthy(); });
    expect(api.calls.filter(c => c.path === "/auth/switch-company").map(c => c.body)).toEqual([
      { membershipId: MEMBERSHIP.membershipId }, { membershipId: MEMBERSHIP.membershipId },
    ]);
    expect(api.calls.filter(c => c.path === LIST).map(c => c.authorization)).toEqual([`Bearer ${TENANT}`, `Bearer ${RENEWED}`]);
  });

  test("DP15. a company the server no longer lets this account act for: the page says so and shows no drivers", async () => {
    companyAdmin([invitation()]);
    api.on(`GET ${LIST}`, { status: 403, body: { error: "Not allowed", code: "FORBIDDEN" } });
    await driversPage();
    await waitFor(() => { expect(main().textContent).toMatch(/not allowed to manage drivers/i); });
    expect(screen.queryByRole("table", { name: "Your drivers" })).toBeNull();
  });
});

describe("Home points here", () => {
  test("DP16. Getting started's next step is now available — Add your first driver, a link to Drivers", async () => {
    companyAdmin();
    renderRoute(PATHS.company);
    await screen.findByRole("heading", { level: 1, name: MEMBERSHIP.companyName });
    const steps = within(screen.getByRole("region", { name: "Getting started" })).getAllByRole("listitem");
    const add = steps[1];
    if (add === undefined) throw new Error("no second step");
    expect(add.getAttribute("data-state")).toBe("available");
    expect(within(add).getByRole("link", { name: /Go to Drivers/ }).getAttribute("href")).toBe("/company/drivers");
  });
});
