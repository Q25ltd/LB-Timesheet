import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { PATHS } from "../../paths";
import { account, installFakeApi, MEMBERSHIP, type FakeApi } from "../../test/fakeApi";
import { renderRoute } from "../../test/renderRoute";

/**
 * D63, stage 4, and D65 — the company website's Drivers page (`/company/drivers`).
 *
 * The company adds a driver by name and email (and its own payroll
 * reference), and sees where each invitation stands: Invited, Declined,
 * Expired or Cancelled. It can correct or cancel one that is still open. A
 * driver who ACCEPTED is one of "Your drivers" (D65): listed Active or
 * Deactivated, and deactivated, reactivated or removed from there. Nothing
 * here looks a driver up: the invitations are what the company typed, and
 * its drivers are the ones who joined it.
 *
 * Every call is the company's: its TENANT token, in memory, never a cookie.
 * An expired tenant token is renewed once — by asking the server for the
 * company again (switch-company) — and the call retried.
 */

const TENANT = "header.tenant.sig";
const RENEWED = "header.tenant.renewed";
const LIST = "/company/driver-invitations";
const MEMBERS = "/company/drivers";

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

function member(over: Record<string, unknown> = {}) {
  return {
    membershipId: "dm-1", firstName: "Dee", lastName: "River", email: "dee@example.com", payrollRef: "EMP-7",
    status: "active", joinedAt: "2026-10-01T08:00:00.000Z", ...over,
  };
}

/** A browser signed in to a company with one admin membership, reloaded on `path`. */
function companyAdmin(invitations: unknown[] = [], members: unknown[] = []) {
  api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
  api.on("GET /auth/me", { status: 200, body: account({ emailVerified: true, memberships: [MEMBERSHIP] }) });
  api.on("POST /auth/switch-company", { status: 200, body: { tenantToken: TENANT, membership: MEMBERSHIP } });
  api.on(`GET ${LIST}`, () => ({ status: 200, body: { invitations } }));
  api.on(`GET ${MEMBERS}`, () => ({ status: 200, body: { drivers: members } }));
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

function rowIn(table: "Your drivers" | "Invitations", name: string): HTMLElement {
  const found = within(screen.getByRole("table", { name: table })).getAllByRole("row").find(r => r.textContent?.includes(name) === true);
  if (found === undefined) throw new Error(`no row for ${name} in ${table}`);
  return found;
}

/** An invitation's row. */
const row = (name: string): HTMLElement => rowIn("Invitations", name);
/** A driver's row — one who joined. */
const memberRow = (name: string): HTMLElement => rowIn("Your drivers", name);

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
  test("DP3. each invitation as the company typed it, and where it stands — in plain words; an ACCEPTED one is listed as a driver instead (D65)", async () => {
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
    expect(() => row("Ben Joined")).toThrow();
    expect(row("Cal Declined").textContent).toMatch(/Declined/);
    expect(row("Dan Expired").textContent).toMatch(/Expired/);
    expect(row("Eve Cancelled").textContent).toMatch(/Cancelled/);
  });

  test("DP4. only an open invitation can be corrected or cancelled", async () => {
    companyAdmin([
      invitation({ id: "a", firstName: "Ann", lastName: "Invited", status: "pending" }),
      invitation({ id: "c", firstName: "Cal", lastName: "Declined", status: "declined" }),
      invitation({ id: "d", firstName: "Dan", lastName: "Expired", status: "expired" }),
    ]);
    await driversPage();
    await waitFor(() => { expect(row("Ann Invited")).toBeTruthy(); });
    expect(within(row("Ann Invited")).getByRole("button", { name: /Edit/ })).toBeTruthy();
    expect(within(row("Ann Invited")).getByRole("button", { name: /Cancel invitation/ })).toBeTruthy();
    for (const name of ["Cal Declined", "Dan Expired"]) expect(within(row(name)).queryAllByRole("button")).toEqual([]);
  });

  test("DP5. with no drivers yet, it says so and says how to begin", async () => {
    companyAdmin([]);
    await driversPage();
    await waitFor(() => { expect(main().textContent).toMatch(/no drivers yet/i); });
    expect(screen.queryByRole("table", { name: "Your drivers" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Invitations" })).toBeNull();
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
    expect(screen.queryByRole("table", { name: "Invitations" })).toBeNull();
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

  test("DP13. an invitation the driver answered meanwhile cannot be changed — the page says so and shows where it now stands: one of Your drivers", async () => {
    let current = invitation();
    let members: unknown[] = [];
    companyAdmin();
    api.on(`GET ${LIST}`, () => ({ status: 200, body: { invitations: [current] } }));
    api.on(`GET ${MEMBERS}`, () => ({ status: 200, body: { drivers: members } }));
    api.on(`POST ${LIST}/inv-1/cancel`, () => {
      current = { ...current, status: "accepted" };
      members = [member({ firstName: "John", lastName: "Smith", email: "john@example.com" })];
      return { status: 409, body: { error: "x", code: "INVITATION_NOT_PENDING" } };
    });
    await driversPage();
    await waitFor(() => { expect(row("John Smith")).toBeTruthy(); });
    fireEvent.click(within(row("John Smith")).getByRole("button", { name: /Cancel invitation/ }));
    fireEvent.click(within(row("John Smith")).getByRole("button", { name: /Yes, cancel/ }));

    await waitFor(() => { expect(screen.getByRole("alert").textContent).toMatch(/no longer open/i); });
    await waitFor(() => { expect(memberRow("John Smith").textContent).toMatch(/Active/); });
    expect(screen.queryByRole("table", { name: "Invitations" })).toBeNull();
  });
});

describe("your drivers (D65)", () => {
  const ACTIVE = member({ membershipId: "dm-1", firstName: "Ann", lastName: "Active", email: "ann@example.com" });
  const INACTIVE = member({ membershipId: "dm-2", firstName: "Ian", lastName: "Inactive", email: "ian@example.com", status: "inactive", payrollRef: null });

  test("DM1. drivers who joined are listed with the account's name and email, the payroll reference and a clear status; active ones can be deactivated or removed, deactivated ones reactivated or removed", async () => {
    companyAdmin([], [ACTIVE, INACTIVE]);
    await driversPage();
    await waitFor(() => { expect(memberRow("Ann Active")).toBeTruthy(); });

    expect(memberRow("Ann Active").textContent).toContain("ann@example.com");
    expect(memberRow("Ann Active").textContent).toContain("EMP-7");
    expect(memberRow("Ann Active").textContent).toMatch(/Active/);
    expect(memberRow("Ian Inactive").textContent).toMatch(/Deactivated/);
    expect(memberRow("Ian Inactive").textContent).toMatch(/cannot start new shifts/i);
    const buttons = (name: string) => within(memberRow(name)).getAllByRole("button").map(b => b.textContent);
    expect(buttons("Ann Active")).toEqual(["Deactivate", "Remove"]);
    expect(buttons("Ian Inactive")).toEqual(["Reactivate", "Remove"]);
    const asked = api.calls.find(c => c.path === MEMBERS);
    expect(asked?.authorization).toBe(`Bearer ${TENANT}`);
    expect(asked?.credentials).toBe("omit");
  });

  test("DM2. Deactivate asks first — saying a started shift can still be finished — then deactivates, with the company's token and no body, and says so", async () => {
    let current = ACTIVE;
    companyAdmin();
    api.on(`GET ${MEMBERS}`, () => ({ status: 200, body: { drivers: [current] } }));
    api.on(`POST ${MEMBERS}/dm-1/deactivate`, () => { current = { ...current, status: "inactive" }; return { status: 200, body: { driver: current } }; });
    await driversPage();
    await waitFor(() => { expect(memberRow("Ann Active")).toBeTruthy(); });

    fireEvent.click(within(memberRow("Ann Active")).getByRole("button", { name: "Deactivate Ann Active" }));
    expect(api.calls.some(c => c.path.endsWith("/deactivate")), "one click asks; it does not deactivate").toBe(false);
    expect(memberRow("Ann Active").textContent).toMatch(/already started can still be finished/i);
    fireEvent.click(within(memberRow("Ann Active")).getByRole("button", { name: "Yes, deactivate" }));

    await waitFor(() => { expect(memberRow("Ann Active").textContent).toMatch(/Deactivated/); });
    expect(screen.getByRole("status").textContent).toMatch(/Ann Active is deactivated/);
    const sent = api.calls.filter(c => c.method === "POST" && c.path === `${MEMBERS}/dm-1/deactivate`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.authorization).toBe(`Bearer ${TENANT}`);
    expect(sent[0]?.body).toBeNull();
    expect(within(memberRow("Ann Active")).getAllByRole("button").map(b => b.textContent)).toEqual(["Reactivate", "Remove"]);
  });

  test("DM3. Remove asks first; confirming removes the driver from the list and says their records are kept and they can be invited again", async () => {
    let members: unknown[] = [ACTIVE];
    companyAdmin();
    api.on(`GET ${MEMBERS}`, () => ({ status: 200, body: { drivers: members } }));
    api.on(`POST ${MEMBERS}/dm-1/remove`, () => { members = []; return { status: 200, body: { driver: { ...ACTIVE, status: "removed" } } }; });
    await driversPage();
    await waitFor(() => { expect(memberRow("Ann Active")).toBeTruthy(); });

    fireEvent.click(within(memberRow("Ann Active")).getByRole("button", { name: "Remove Ann Active" }));
    expect(api.calls.some(c => c.path.endsWith("/remove")), "one click asks; it does not remove").toBe(false);
    fireEvent.click(within(memberRow("Ann Active")).getByRole("button", { name: "Yes, remove" }));

    await waitFor(() => { expect(screen.queryByRole("table", { name: "Your drivers" })).toBeNull(); });
    expect(main().textContent).toMatch(/Ann Active is removed/);
    expect(main().textContent).toMatch(/invite them again/i);
  });

  test("DM4. No keeps the driver as they were — nothing is sent", async () => {
    companyAdmin([], [ACTIVE]);
    await driversPage();
    await waitFor(() => { expect(memberRow("Ann Active")).toBeTruthy(); });
    for (const name of ["Deactivate Ann Active", "Remove Ann Active"]) {
      fireEvent.click(within(memberRow("Ann Active")).getByRole("button", { name }));
      fireEvent.click(within(memberRow("Ann Active")).getByRole("button", { name: "No" }));
    }
    expect(api.calls.filter(c => c.method === "POST" && c.path.startsWith(`${MEMBERS}/`))).toEqual([]);
    expect(within(memberRow("Ann Active")).getAllByRole("button").map(b => b.textContent)).toEqual(["Deactivate", "Remove"]);
  });

  test("DM5. Reactivate restores a deactivated driver at once", async () => {
    let current = INACTIVE;
    companyAdmin();
    api.on(`GET ${MEMBERS}`, () => ({ status: 200, body: { drivers: [current] } }));
    api.on(`POST ${MEMBERS}/dm-2/reactivate`, () => { current = { ...current, status: "active" }; return { status: 200, body: { driver: current } }; });
    await driversPage();
    await waitFor(() => { expect(memberRow("Ian Inactive")).toBeTruthy(); });

    fireEvent.click(within(memberRow("Ian Inactive")).getByRole("button", { name: "Reactivate Ian Inactive" }));

    await waitFor(() => { expect(memberRow("Ian Inactive").textContent).toMatch(/Active/); });
    expect(memberRow("Ian Inactive").textContent).not.toMatch(/Deactivated/);
    expect(screen.getByRole("status").textContent).toMatch(/active again/i);
  });

  test("DM6. a double click sends ONE action — the buttons wait for the answer", async () => {
    companyAdmin([], [ACTIVE]);
    api.on(`POST ${MEMBERS}/dm-1/deactivate`, { status: 200, body: { driver: { ...ACTIVE, status: "inactive" } } });
    await driversPage();
    await waitFor(() => { expect(memberRow("Ann Active")).toBeTruthy(); });
    fireEvent.click(within(memberRow("Ann Active")).getByRole("button", { name: "Deactivate Ann Active" }));
    const yes = within(memberRow("Ann Active")).getByRole("button", { name: "Yes, deactivate" });

    fireEvent.click(yes);
    fireEvent.click(yes);

    await waitFor(() => { expect(screen.getByRole("status").textContent).toMatch(/deactivated/); });
    expect(api.calls.filter(c => c.path === `${MEMBERS}/dm-1/deactivate`)).toHaveLength(1);
  });

  test("DM7. every refusal is said plainly, and the list shows where the driver now stands", async () => {
    const cases: [object, RegExp][] = [
      [{ status: 409, body: { error: "x", code: "MEMBERSHIP_STATE" } }, /status had already changed/i],
      [{ status: 404, body: { error: "Not found", code: "NOT_FOUND" } }, /no longer one of your drivers/i],
      [{ status: 503, body: { error: "x" } }, /could not change Ann Active.*Nothing was changed/i],
    ];
    for (const [answer, said] of cases) {
      document.body.innerHTML = "";
      api = installFakeApi();
      companyAdmin([], [ACTIVE]);
      api.on(`POST ${MEMBERS}/dm-1/deactivate`, answer as { status: number; body?: unknown });
      await driversPage();
      await waitFor(() => { expect(memberRow("Ann Active")).toBeTruthy(); });
      fireEvent.click(within(memberRow("Ann Active")).getByRole("button", { name: "Deactivate Ann Active" }));
      fireEvent.click(within(memberRow("Ann Active")).getByRole("button", { name: "Yes, deactivate" }));
      await waitFor(() => { expect(screen.getByRole("alert").textContent).toMatch(said); });
      await waitFor(() => { expect(api.calls.filter(c => c.method === "GET" && c.path === MEMBERS)).toHaveLength(2); });
    }
  });

  test("DM8. adding a DEACTIVATED driver is refused — the page says to reactivate them instead", async () => {
    companyAdmin([], [INACTIVE]);
    api.on(`POST ${LIST}`, { status: 409, body: { error: "x", code: "DRIVER_INACTIVE" } });
    await driversPage();
    fill({ "First name": "Ian", "Last name": "Inactive", "Email address": "ian@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Add driver" }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toMatch(/deactivated\. Reactivate them/i); });
  });

  test("DM9. drivers that could not be loaded — or an answer with a status the page does not know — are never drawn; it says the list could not be loaded", async () => {
    for (const answer of [{ status: 503, body: { error: "x" } }, { status: 200, body: { drivers: [member({ status: "removed" })] } }]) {
      document.body.innerHTML = "";
      api = installFakeApi();
      companyAdmin([invitation()]);
      api.on(`GET ${MEMBERS}`, answer);
      await driversPage();
      await waitFor(() => { expect(main().textContent).toMatch(/could not load your drivers/i); });
      expect(screen.queryByRole("table", { name: "Your drivers" })).toBeNull();
      expect(screen.queryByRole("table", { name: "Invitations" })).toBeNull();
    }
  });

  test("DM10. joined drivers and open invitations side by side: each in its own list", async () => {
    companyAdmin([invitation({ firstName: "Ivy", lastName: "Invited" })], [ACTIVE]);
    await driversPage();
    await waitFor(() => { expect(memberRow("Ann Active")).toBeTruthy(); });
    expect(row("Ivy Invited").textContent).toMatch(/Invited/);
    expect(() => row("Ann Active")).toThrow();
    expect(() => memberRow("Ivy Invited")).toThrow();
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
    expect(screen.queryByRole("table", { name: "Invitations" })).toBeNull();
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
