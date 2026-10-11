import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { PATHS } from "../../paths";
import { account, installFakeApi, MEMBERSHIP, type FakeApi } from "../../test/fakeApi";
import { renderRoute } from "../../test/renderRoute";

/**
 * D66, stage S1 — the company website's Settings (`/company/settings`):
 * the company's measurement units. Both chosen together; nothing
 * preselected for a company that has none; every call the company's, with
 * its tenant token in memory.
 */

const TENANT = "header.tenant.sig";
const UNITS = "/company/settings/units";
const REPORT = "/company/settings/report-email";

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

function companyAdmin(units: { distanceUnit: string | null; volumeUnit: string | null } = { distanceUnit: "kilometre", volumeUnit: "litre" }) {
  api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
  api.on("GET /auth/me", { status: 200, body: account({ emailVerified: true, memberships: [MEMBERSHIP] }) });
  api.on("POST /auth/switch-company", { status: 200, body: { tenantToken: TENANT, membership: MEMBERSHIP } });
  api.on(`GET ${UNITS}`, () => ({ status: 200, body: { units } }));
  api.on(`GET ${REPORT}`, { status: 200, body: { reportEmail: { address: null, verified: false } } });
}

async function settingsPage() {
  renderRoute(PATHS.companySettings);
  await screen.findByRole("heading", { level: 1, name: "Settings" });
}

function select(label: string): HTMLSelectElement {
  return screen.getByLabelText<HTMLSelectElement>(label);
}

function main(): HTMLElement {
  const element = document.querySelector("main");
  if (element === null) throw new Error("no <main>");
  return element;
}

describe("Settings (D66)", () => {
  test("ST1. Settings is a real place: a link in the company navigation, current on its page; the units are read with the COMPANY's token", async () => {
    companyAdmin();
    await settingsPage();
    const nav = screen.getByRole("navigation", { name: "Company" });
    const link = within(nav).getByRole("link", { name: "Settings" });
    expect(link.getAttribute("aria-current")).toBe("page");
    await waitFor(() => { expect(select("Distance unit").value).toBe("kilometre"); });
    const read = api.calls.find(c => c.path === UNITS);
    expect(read?.authorization).toBe(`Bearer ${TENANT}`);
    expect(read?.credentials).toBe("omit");
  });

  test("ST2. the company's units are shown as chosen, and changing them sends both — and only both — and says what a change means", async () => {
    let units: { distanceUnit: string | null; volumeUnit: string | null } = { distanceUnit: "kilometre", volumeUnit: "litre" };
    companyAdmin();
    api.on(`GET ${UNITS}`, () => ({ status: 200, body: { units } }));
    api.on(`PUT ${UNITS}`, call => { units = call.body as typeof units; return { status: 200, body: { units } }; });
    await settingsPage();
    await waitFor(() => { expect(select("Fuel unit").value).toBe("litre"); });

    fireEvent.change(select("Distance unit"), { target: { value: "mile" } });
    fireEvent.change(select("Fuel unit"), { target: { value: "imperial_gallon" } });
    fireEvent.click(screen.getByRole("button", { name: "Save units" }));

    await waitFor(() => { expect(screen.getByRole("status").textContent).toMatch(/units saved/i); });
    expect(screen.getByRole("status").textContent).toMatch(/earlier records keep their own units/i);
    const sent = api.calls.filter(c => c.method === "PUT" && c.path === UNITS);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ distanceUnit: "mile", volumeUnit: "imperial_gallon" });
    expect(sent[0]?.authorization).toBe(`Bearer ${TENANT}`);
  });

  test("ST3. a company with NO units is told so, nothing is preselected, and nothing is sent until BOTH are chosen", async () => {
    companyAdmin({ distanceUnit: null, volumeUnit: null });
    await settingsPage();
    await waitFor(() => { expect(main().textContent).toMatch(/has not chosen its units yet/i); });
    expect([select("Distance unit").value, select("Fuel unit").value]).toEqual(["", ""]);

    fireEvent.change(select("Distance unit"), { target: { value: "kilometre" } });
    fireEvent.click(screen.getByRole("button", { name: "Save units" }));

    expect(await screen.findByText("Choose the unit fuel is recorded in")).toBeTruthy();
    expect(api.calls.some(c => c.method === "PUT")).toBe(false);
  });

  test("ST4. every refusal is said plainly, and what was chosen is kept", async () => {
    const cases: [object, RegExp][] = [
      [{ status: 403, body: { error: "Not allowed", code: "FORBIDDEN" } }, /not allowed to change this company's settings/i],
      [{ status: 503, body: { error: "x" } }, /could not save your units.*nothing was changed/i],
    ];
    for (const [answer, said] of cases) {
      document.body.innerHTML = "";
      api = installFakeApi();
      companyAdmin();
      api.on(`PUT ${UNITS}`, answer as { status: number; body?: unknown });
      await settingsPage();
      await waitFor(() => { expect(select("Distance unit").value).toBe("kilometre"); });
      fireEvent.change(select("Distance unit"), { target: { value: "mile" } });
      fireEvent.click(screen.getByRole("button", { name: "Save units" }));
      await waitFor(() => { expect(screen.getByRole("alert").textContent).toMatch(said); });
      expect(select("Distance unit").value).toBe("mile");
    }
  });

  test("ST5. units that could not be read — or a unit the page does not know — are never shown as chosen; it says the settings could not be loaded", async () => {
    for (const answer of [{ status: 503, body: { error: "x" } }, { status: 200, body: { units: { distanceUnit: "furlong", volumeUnit: "litre" } } }]) {
      document.body.innerHTML = "";
      api = installFakeApi();
      companyAdmin();
      api.on(`GET ${UNITS}`, answer);
      await settingsPage();
      await waitFor(() => { expect(main().textContent).toMatch(/could not load your settings/i); });
      expect(screen.queryByLabelText("Distance unit")).toBeNull();
    }
  });

  test("ST6. an account the server does not let manage the company is told so, and shown no form", async () => {
    companyAdmin();
    api.on(`GET ${UNITS}`, { status: 403, body: { error: "Not allowed", code: "FORBIDDEN" } });
    await settingsPage();
    await waitFor(() => { expect(main().textContent).toMatch(/not allowed to change this company's settings/i); });
    expect(screen.queryByRole("button", { name: "Save units" })).toBeNull();
  });
});

describe("Report email (D66)", () => {
  function section(): HTMLElement {
    return screen.getByRole("region", { name: "Report email" });
  }

  test("RM1. with no address, it says nothing is emailed until one is confirmed; saving sends the address — and only it — and says a link was sent", async () => {
    let report = { address: null as string | null, verified: false };
    companyAdmin();
    api.on(`GET ${REPORT}`, () => ({ status: 200, body: { reportEmail: report } }));
    api.on(`PUT ${REPORT}`, call => {
      const { email } = call.body as { email: string };
      report = { address: email.toLowerCase(), verified: false };
      return { status: 200, body: { reportEmail: report } };
    });
    await settingsPage();
    await waitFor(() => { expect(section().textContent).toMatch(/no report address yet/i); });

    fireEvent.change(within(section()).getByLabelText("Report email address"), { target: { value: " Payroll@Example.com " } });
    fireEvent.click(within(section()).getByRole("button", { name: "Save address" }));

    await waitFor(() => { expect(section().textContent).toMatch(/sent a confirmation link to payroll@example\.com/i); });
    expect(section().textContent).toMatch(/waiting for confirmation/i);
    const sent = api.calls.filter(c => c.method === "PUT" && c.path === REPORT);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ email: "Payroll@Example.com" });
    expect(sent[0]?.authorization).toBe(`Bearer ${TENANT}`);
  });

  test("RM2. a confirmed address says reports go there; an unconfirmed one offers the link again, sending the same address", async () => {
    companyAdmin();
    api.on(`GET ${REPORT}`, { status: 200, body: { reportEmail: { address: "payroll@example.com", verified: true } } });
    await settingsPage();
    await waitFor(() => { expect(section().textContent).toMatch(/Reports are emailed to payroll@example\.com/); });
    expect(within(section()).queryByRole("button", { name: "Send the link again" })).toBeNull();

    document.body.innerHTML = "";
    api = installFakeApi();
    companyAdmin();
    api.on(`GET ${REPORT}`, { status: 200, body: { reportEmail: { address: "ops@example.com", verified: false } } });
    api.on(`PUT ${REPORT}`, { status: 200, body: { reportEmail: { address: "ops@example.com", verified: false } } });
    await settingsPage();
    await waitFor(() => { expect(within(section()).getByRole("button", { name: "Send the link again" })).toBeTruthy(); });
    fireEvent.click(within(section()).getByRole("button", { name: "Send the link again" }));
    await waitFor(() => { expect(api.calls.some(c => c.method === "PUT" && c.path === REPORT)).toBe(true); });
    expect(api.calls.find(c => c.method === "PUT" && c.path === REPORT)?.body).toEqual({ email: "ops@example.com" });
  });

  test("RM3. not an address: caught on the page, nothing sent", async () => {
    companyAdmin();
    await settingsPage();
    await waitFor(() => { expect(within(section()).getByLabelText("Report email address")).toBeTruthy(); });
    fireEvent.change(within(section()).getByLabelText("Report email address"), { target: { value: "not-an-address" } });
    fireEvent.click(within(section()).getByRole("button", { name: "Save address" }));
    expect(await within(section()).findByText("Enter a valid email address.")).toBeTruthy();
    expect(api.calls.some(c => c.method === "PUT")).toBe(false);
  });

  test("RM4. every refusal is said plainly", async () => {
    const cases: [object, RegExp][] = [
      [{ status: 409, body: { error: "x", code: "EMAIL_UNDELIVERABLE" } }, /cannot be delivered/i],
      [{ status: 429, body: { error: "x", code: "RATE_LIMITED" } }, /several confirmation emails/i],
      [{ status: 503, body: { error: "x", code: "EMAIL_UNAVAILABLE" } }, /could not be sent just now/i],
    ];
    for (const [answer, said] of cases) {
      document.body.innerHTML = "";
      api = installFakeApi();
      companyAdmin();
      api.on(`PUT ${REPORT}`, answer as { status: number; body?: unknown });
      await settingsPage();
      await waitFor(() => { expect(within(section()).getByLabelText("Report email address")).toBeTruthy(); });
      fireEvent.change(within(section()).getByLabelText("Report email address"), { target: { value: "payroll@example.com" } });
      fireEvent.click(within(section()).getByRole("button", { name: "Save address" }));
      await waitFor(() => { expect(within(section()).getByRole("alert").textContent).toMatch(said); });
    }
  });
});

describe("Confirming a report address (D66)", () => {
  test("RC1. the link's token is posted — with no sign-in — and the page says which company's reports will come here", async () => {
    api.on("POST /auth/web/refresh", { status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } });
    api.on(`POST ${REPORT}/confirm`, { status: 200, body: { companyName: "Baltic Freight UAB" } });
    renderRoute(`${PATHS.confirmReportEmail}#token=abc123_-XYZ`);
    expect(await screen.findByRole("heading", { level: 1, name: "Report address confirmed" })).toBeTruthy();
    expect(main().textContent).toMatch(/Baltic Freight UAB/);
    const sent = api.calls.find(c => c.path === `${REPORT}/confirm`);
    expect(sent?.body).toEqual({ token: "abc123_-XYZ" });
    expect(sent?.authorization).toBeNull();
  });

  test("RC2. a used, expired or superseded link is said to be unusable — and what to do", async () => {
    api.on("POST /auth/web/refresh", { status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } });
    api.on(`POST ${REPORT}/confirm`, { status: 400, body: { error: "x", code: "TOKEN_INVALID" } });
    renderRoute(`${PATHS.confirmReportEmail}#token=abc123`);
    expect(await screen.findByRole("heading", { level: 1, name: "This link cannot be used" })).toBeTruthy();
    expect(main().textContent).toMatch(/send a new link from Settings/i);
  });
});
