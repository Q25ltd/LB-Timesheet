import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PATHS } from "../../paths";
import { account, installFakeApi, type FakeApi } from "../../test/fakeApi";
import { renderRoute } from "../../test/renderRoute";

/**
 * `/register` registers a COMPANY (D51): company details plus the initial
 * administrator's details, on one form.
 *
 * Until the company-registration API exists (increment 4) the form validates
 * but SENDS NOTHING — no request of any kind — and says so. It must never
 * fall back on the old person-first registration endpoint, which would drop
 * the company name and report a registration that did not happen.
 */

let api: FakeApi;

/**
 * The timezone THIS DEVICE reports, which the page may only SUGGEST (D53).
 * Pinned in every test, so no result depends on the machine running them.
 */
function deviceTimeZone(zone: string | undefined) {
  const real = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...real, timeZone: zone as string });
}

beforeEach(() => {
  api = installFakeApi();
  deviceTimeZone("Asia/Tokyo");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function main(): HTMLElement {
  const element = document.querySelector("main");
  if (element === null) throw new Error("no <main>");
  return element;
}

function group(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function timeZone(): HTMLSelectElement {
  const element = within(group("Company details")).getByLabelText("Time zone");
  if (!(element instanceof HTMLSelectElement)) throw new Error("the time zone is not a list to choose from");
  return element;
}

function fillAdministrator() {
  fill("First name", "Nerijus");
  fill("Last name", "Kuizinas");
  fill("Email", "owner@example.com");
  fill("Password", "correct-horse-battery-staple");
  fill("Repeat password", "correct-horse-battery-staple");
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Register company" }));
}

/** Every request the page made, other than restoring an existing session. */
function registrationRequests(): string[] {
  return api.calls.filter(c => c.path !== "/auth/web/refresh").map(c => `${c.method} ${c.path}`);
}

describe("the page registers a company", () => {
  test("its heading is 'Register your company', and it explains the administrator's role", () => {
    renderRoute(PATHS.register);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Register your company");
    expect(main().textContent).toMatch(/administrator/i);
  });

  test("Company details hold the company name; Administrator details hold the person", () => {
    renderRoute(PATHS.register);
    expect(within(group("Company details")).getByLabelText("Company name")).toBeTruthy();
    const admin = group("Administrator details");
    for (const label of ["First name", "Last name", "Email", "Password", "Repeat password"]) {
      expect(within(admin).getByLabelText(label), label).toBeTruthy();
    }
    expect(within(group("Company details")).queryByLabelText("Email")).toBeNull();
  });

  test("the password field keeps its accessibility and password-manager behaviour", () => {
    renderRoute(PATHS.register);
    const password = screen.getByLabelText("Password");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Company name").getAttribute("autocomplete")).toBe("organization");
  });

  test("none of the old person-first or driver wording remains", () => {
    renderRoute(PATHS.register);
    const text = main().textContent ?? "";
    for (const obsolete of [/create your account/i, /your own account/i, /create account/i, /set up your company once/i, /driver/i]) {
      expect(text, String(obsolete)).not.toMatch(obsolete);
    }
  });
});

describe("navigation", () => {
  test("'Already registered? Sign in' takes an existing company to company sign-in", async () => {
    renderRoute(PATHS.register);
    const signIn = within(main()).getByRole("link", { name: "Sign in" });
    expect(signIn.getAttribute("href")).toBe(PATHS.login);
    expect(signIn.parentElement?.textContent).toBe("Already registered? Sign in");
    fireEvent.click(signIn);
    await screen.findByRole("heading", { level: 1, name: "Company sign-in" });
  });
});

describe("company name rules", () => {
  test("required: an empty company name is refused with a message on the field", () => {
    renderRoute(PATHS.register);
    fillAdministrator();
    submit();
    expect(within(group("Company details")).getByText("Enter your company's name")).toBeTruthy();
    expect(screen.getByLabelText("Company name").getAttribute("aria-invalid")).toBe("true");
  });

  test("a whitespace-only company name is refused", () => {
    renderRoute(PATHS.register);
    fill("Company name", "   \t ");
    fillAdministrator();
    submit();
    expect(screen.getByText("Enter your company's name")).toBeTruthy();
  });

  test("more than 200 characters is refused; exactly 200 is accepted", () => {
    renderRoute(PATHS.register);
    fill("Company name", "x".repeat(201));
    fillAdministrator();
    submit();
    expect(screen.getByText("Company name must be 200 characters or fewer")).toBeTruthy();

    fill("Company name", "x".repeat(200));
    submit();
    expect(screen.queryByText("Company name must be 200 characters or fewer")).toBeNull();
    expect(screen.getByLabelText("Company name").getAttribute("aria-invalid")).toBeNull();
  });

  test("surrounding spaces are trimmed — '  Acme Haulage  ' is a valid name; inner spacing is the owner's", () => {
    renderRoute(PATHS.register);
    fill("Company name", "  Acme  Road Haulage  ");
    fillAdministrator();
    submit();
    expect(screen.getByLabelText("Company name").getAttribute("aria-invalid")).toBeNull();
  });
});

describe("registering (D51)", () => {
  function fillValid() {
    fill("Company name", "  Kuizinas Haulage Ltd  ");
    fireEvent.change(timeZone(), { target: { value: "America/Chicago" } });
    fillAdministrator();
  }

  test("the temporary 'not open yet' behaviour is gone", () => {
    renderRoute(PATHS.register);
    expect(main().textContent).not.toMatch(/not open yet|nothing has been sent|nothing is sent/i);
  });

  test("a valid form REGISTERS the company: one request to the browser route, with the company, its time zone and the administrator — never the repeat box", async () => {
    api.on("POST /auth/web/register", { status: 201, body: { user: { id: "u-1", firstName: "Nerijus", lastName: "Kuizinas", email: "owner@example.com" }, identityToken: "header.identity.sig", memberships: [] } });
    api.on("GET /auth/me", { status: 200, body: account({ emailVerified: false, pendingCompanyRegistration: { companyName: "Kuizinas Haulage Ltd", timezone: "America/Chicago" } }) });
    renderRoute(PATHS.register);
    fillValid();
    submit();

    await screen.findByRole("heading", { level: 1, name: "Check your email" });
    const sent = api.calls.filter(c => c.path === "/auth/web/register");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.credentials).toBe("include");
    expect(sent[0]?.body).toEqual({
      companyName: "Kuizinas Haulage Ltd", timeZone: "America/Chicago",
      firstName: "Nerijus", lastName: "Kuizinas", email: "owner@example.com", password: "correct-horse-battery-staple",
    });
    expect(api.calls.some(c => c.path === "/auth/register" || c.path === "/companies")).toBe(false);
  });

  test("an email already registered as a COMPANY keeps the form, and says so on the email field", async () => {
    api.on("POST /auth/web/register", { status: 409, body: { error: "Email already registered", code: "EMAIL_IN_USE" } });
    renderRoute(PATHS.register);
    fillValid();
    submit();
    expect(await screen.findByText("A company account already uses this email. Sign in instead, or reset its password.")).toBeTruthy();
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Register your company");
  });

  test("a server failure is reported honestly, and the form is kept", async () => {
    api.on("POST /auth/web/register", { status: 503, body: { error: "Unavailable" } });
    renderRoute(PATHS.register);
    fillValid();
    submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be completed/i);
    const companyName = screen.getByLabelText("Company name");
    expect(companyName instanceof HTMLInputElement ? companyName.value : null).toBe("  Kuizinas Haulage Ltd  ");
  });

  test("no answer at all is reported as no answer", async () => {
    api.on("POST /auth/web/register", () => "offline");
    renderRoute(PATHS.register);
    fillValid();
    submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach/i);
  });

  test("an invalid form sends nothing", () => {
    renderRoute(PATHS.register);
    submit();
    expect(registrationRequests()).toEqual([]);
  });
});

describe("the company's time zone (D53)", () => {
  test("is chosen in COMPANY details, from a list — a normal person never types an IANA name", () => {
    renderRoute(PATHS.register);
    const select = timeZone();
    expect(select.getAttribute("autocomplete")).toBe("off");
    expect(within(group("Administrator details")).queryByLabelText("Time zone")).toBeNull();
    // Grouped by region, each a place named in words, with the IANA id underneath.
    const tokyo = [...select.options].find(option => option.value === "Asia/Tokyo");
    expect(tokyo?.textContent).toMatch(/^Tokyo — /);
    expect(tokyo?.parentElement?.tagName).toBe("OPTGROUP");
    expect(tokyo?.parentElement?.getAttribute("label")).toBe("Asia");
  });

  test("offers places only — no UTC, no Etc/ zones, no offsets", () => {
    renderRoute(PATHS.register);
    const values = [...timeZone().options].map(option => option.value).filter(value => value !== "");
    expect(values.length).toBeGreaterThan(300);
    for (const value of values) {
      expect(value, value).toMatch(/^[A-Z][A-Za-z]*(\/[A-Z][A-Za-z0-9_+-]*)+$/);
      expect(value.startsWith("Etc/"), value).toBe(false);
    }
  });

  test("even where a browser lists UTC, Etc/ zones or offsets, only the places are offered", () => {
    vi.spyOn(Intl, "supportedValuesOf").mockReturnValue(["UTC", "GMT", "Etc/GMT+5", "Etc/UTC", "+01:00", "Europe/Vilnius", "America/Chicago"]);
    deviceTimeZone("UTC");
    renderRoute(PATHS.register);
    expect([...timeZone().options].map(option => option.value)).toEqual(["", "America/Chicago", "Europe/Vilnius"]);
    // UTC is not a place, so it is not suggested either.
    expect(timeZone().value).toBe("");
  });

  test("this device's zone is SUGGESTED, and says so — and the company can change it", () => {
    renderRoute(PATHS.register);
    expect(timeZone().value).toBe("Asia/Tokyo");
    expect(within(group("Company details")).getByText(/suggested from this device/i)).toBeTruthy();

    fireEvent.change(timeZone(), { target: { value: "America/Chicago" } });
    expect(timeZone().value).toBe("America/Chicago");
  });

  test("a non-UK company's own zone is what is sent", async () => {
    api.on("POST /auth/web/register", { status: 409, body: { error: "Email already registered", code: "EMAIL_IN_USE" } });
    renderRoute(PATHS.register);
    fill("Company name", "Chicago Freight LLC");
    fireEvent.change(timeZone(), { target: { value: "America/Chicago" } });
    fillAdministrator();
    submit();
    await waitFor(() => expect(api.calls.some(c => c.path === "/auth/web/register")).toBe(true));
    expect(api.calls.find(c => c.path === "/auth/web/register")?.body).toMatchObject({ timeZone: "America/Chicago" });
  });

  test.each([["UTC"], ["Etc/GMT+5"], [undefined], ["Not/AZone"]])(
    "a device zone that is not a place (%s) suggests NOTHING — never Europe/London — and the company must choose",
    zone => {
      deviceTimeZone(zone);
      renderRoute(PATHS.register);
      expect(timeZone().value).toBe("");
      expect(within(group("Company details")).queryByText(/suggested from this device/i)).toBeNull();

      fill("Company name", "Somewhere Haulage");
      fillAdministrator();
      submit();
      expect(within(group("Company details")).getByText("Choose your company's time zone")).toBeTruthy();
      expect(timeZone().getAttribute("aria-invalid")).toBe("true");
      expect(registrationRequests()).toEqual([]);
    },
  );
});
