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

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

function companyAdmin(units: { distanceUnit: string | null; volumeUnit: string | null } = { distanceUnit: "kilometre", volumeUnit: "litre" }) {
  api.on("POST /auth/web/refresh", { status: 200, body: { identityToken: "header.identity.sig" } });
  api.on("GET /auth/me", { status: 200, body: account({ emailVerified: true, memberships: [MEMBERSHIP] }) });
  api.on("POST /auth/switch-company", { status: 200, body: { tenantToken: TENANT, membership: MEMBERSHIP } });
  api.on(`GET ${UNITS}`, () => ({ status: 200, body: { units } }));
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
