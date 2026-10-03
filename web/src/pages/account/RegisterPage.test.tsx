import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { PATHS } from "../../paths";
import { installFakeApi, type FakeApi } from "../../test/fakeApi";
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

beforeEach(() => {
  api = installFakeApi();
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

describe("before company registration opens", () => {
  test("the page says plainly that registration is not open yet", () => {
    renderRoute(PATHS.register);
    expect(screen.getByText(/company registration is not open yet/i)).toBeTruthy();
  });

  test("a complete, valid form sends NOTHING — no request at all, and never the old registration endpoint", () => {
    renderRoute(PATHS.register);
    fill("Company name", "Kuizinas Haulage Ltd");
    fillAdministrator();
    submit();

    expect(screen.getByRole("status").textContent).toMatch(/nothing has been sent/i);
    expect(registrationRequests()).toEqual([]);
    expect(api.calls.some(c => c.path === "/auth/web/register" || c.path === "/auth/register" || c.path === "/companies")).toBe(false);
    // And it did not pretend to sign anyone in.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Register your company");
  });

  test("an invalid form sends nothing either", () => {
    renderRoute(PATHS.register);
    submit();
    expect(registrationRequests()).toEqual([]);
  });
});
