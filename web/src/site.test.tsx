import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { LOGISTICBAY, PATHS, SECTION } from "./paths";
import { renderRoute } from "./test/renderRoute";

/**
 * The site's structural promises, each checked against the real route table:
 * no link is broken, the unfinished company entry points say they are
 * unfinished and pretend nothing, and every page is navigable by heading and
 * by accessible name.
 */

const PAGES = [PATHS.home, PATHS.register, PATHS.login, PATHS.forgotPassword, PATHS.verifyEmail, PATHS.resetPassword] as const;

const OUTBOUND: ReadonlySet<string> = new Set(Object.values(LOGISTICBAY));

function linkHrefs(): string[] {
  return [...document.querySelectorAll("a[href]")].map(link => link.getAttribute("href") ?? "");
}

function pageHeading(): string {
  return screen.getByRole("heading", { level: 1 }).textContent ?? "";
}

function robotsMeta(): string | null {
  return document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null;
}

describe("links", () => {
  test("every link on every page leads to a real page or a section that exists", () => {
    const checked = new Set<string>();
    for (const page of PAGES) {
      const { unmount } = renderRoute(page);
      const hrefs = linkHrefs();
      unmount();

      for (const href of hrefs) {
        if (checked.has(href)) continue;
        checked.add(href);

        // The only links away from this site are the other LogisticBay
        // websites and support@ (BRAND.md § Navigation): no social account,
        // partner or legal page exists to link to.
        if (OUTBOUND.has(href)) continue;
        expect(href.startsWith("/") || href.startsWith("#"), `link leaves the site: ${href}`).toBe(true);

        const [path = "", hash] = href.split("#");
        const view = renderRoute(path === "" ? page : path);
        expect(pageHeading(), `${href} renders the not-found page`).not.toBe("Page not found");
        if (hash !== undefined && hash !== "") {
          expect(document.getElementById(hash), `${href} names a section that does not exist`).not.toBeNull();
        }
        view.unmount();
      }
    }
    // The walk really visited the section links and the company entry points.
    for (const expected of [`/#${SECTION.howItWorks}`, PATHS.register, PATHS.login, ...OUTBOUND]) {
      expect(checked.has(expected), `no link to ${expected} was found`).toBe(true);
    }
  });

  test("See how it works, in the hero, points at the How it works section", () => {
    renderRoute(PATHS.home);
    const hero = screen.getByRole("region", { name: "Driver timesheets without the paperwork." });
    const link = within(hero).getByRole("link", { name: "See how it works" });
    expect(link.getAttribute("href")).toBe(`/#${SECTION.howItWorks}`);
    expect(document.getElementById(SECTION.howItWorks)).toHaveProperty("tagName", "SECTION");
  });

  test("an unknown address shows the not-found page, kept out of search results", () => {
    renderRoute("/no-such-page");
    expect(pageHeading()).toBe("Page not found");
    expect(robotsMeta()).toBe("noindex");
  });
});

describe("account entry points", () => {
  // Every way into company registration or sign-in that the site offers:
  // in the header, in the hero, on the company-portal card and in the closing
  // call to action (sign-in: header, hero, closing call to action).
  const ENTRY_POINTS = [
    { name: "Register company", path: PATHS.register, count: 4 },
    { name: "Sign in", path: PATHS.login, count: 3 },
  ] as const;

  test.each(ENTRY_POINTS)("$name leads to $path, wherever the homepage offers it", ({ name, path, count }) => {
    renderRoute(PATHS.home);
    const links = screen.getAllByRole("link", { name });
    expect(links).toHaveLength(count);
    for (const link of links) expect(link.getAttribute("href")).toBe(path);
  });

  test("the hero's main action is registering a company; signing in sits beside it", () => {
    renderRoute(PATHS.home);
    const hero = screen.getByRole("region", { name: "Driver timesheets without the paperwork." });
    const actions = within(hero).getAllByRole("link");
    expect(actions[0]?.textContent).toBe("Register company");
    expect(actions[0]?.getAttribute("href")).toBe(PATHS.register);
    expect(within(hero).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(PATHS.login);
  });

  test("the vague 'Get started' and the old 'Log in' / 'Company login' labels are gone", () => {
    renderRoute(PATHS.home);
    for (const obsolete of ["Get started", "Log in", "Company login"]) {
      expect(screen.queryAllByRole("link", { name: obsolete }), obsolete).toHaveLength(0);
    }
  });

  test("/register registers a COMPANY — company details and administrator details on one form", () => {
    renderRoute(PATHS.register);
    expect(pageHeading()).toBe("Register your company");
    for (const label of ["Company name", "First name", "Last name", "Email", "Password", "Repeat password"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
    const main = document.querySelector("main");
    if (main === null) throw new Error("no <main>");
    expect(within(main).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(PATHS.login);
    expect(robotsMeta()).toBe("noindex");
  });

  test("/login is COMPANY sign-in — and it sends a new company to registration", () => {
    renderRoute(PATHS.login);
    expect(pageHeading()).toBe("Company sign-in");
    expect(document.querySelector("main")?.textContent).toMatch(/company account/i);
    expect(screen.getByRole("link", { name: "Register your company" }).getAttribute("href")).toBe(PATHS.register);
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
    expect(screen.getByRole("link", { name: "Forgotten your password?" }).getAttribute("href")).toBe(PATHS.forgotPassword);
    expect(robotsMeta()).toBe("noindex");
  });

  test("the homepage itself is indexable", () => {
    renderRoute(PATHS.home);
    expect(robotsMeta()).toBeNull();
  });
});

describe("structure and accessible names", () => {
  test.each(PAGES)("%s has exactly one h1, and its headings never skip a level", page => {
    renderRoute(page);
    const levels = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map(heading => Number(heading.tagName[1]));
    expect(levels.filter(level => level === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    levels.forEach((level, index) => {
      if (index === 0) return;
      const previous = levels[index - 1] ?? 1;
      expect(level, `heading ${String(index)} jumps from h${String(previous)} to h${String(level)}`).toBeLessThanOrEqual(previous + 1);
    });
  });

  test("every homepage section after the hero is titled by an h2", () => {
    renderRoute(PATHS.home);
    const sections = [...document.querySelectorAll("main > section")].slice(1);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      const title = document.getElementById(section.getAttribute("aria-labelledby") ?? "");
      expect(title?.tagName, section.className).toBe("H2");
    }
  });

  test("the homepage headline is the product promise", () => {
    renderRoute(PATHS.home);
    expect(pageHeading()).toBe("Driver timesheets without the paperwork.");
  });

  test.each(PAGES)("%s: every link, button and image has an accessible name", page => {
    renderRoute(page);
    expect(screen.getAllByRole("link").length).toBe(screen.getAllByRole("link", { name: /\S/ }).length);
    expect(screen.queryAllByRole("button").length).toBe(screen.queryAllByRole("button", { name: /\S/ }).length);
    expect(screen.queryAllByRole("img").length).toBe(screen.queryAllByRole("img", { name: /\S/ }).length);
    // A decorative <img> must say so with alt="" rather than have no alt.
    expect(document.querySelectorAll("img:not([alt])")).toHaveLength(0);
  });

  test("the driver-app pictures are real captures, each one described image — never controls that do nothing", () => {
    renderRoute(PATHS.home);
    const pictures = screen.getAllByRole("img", { name: /^The Timesheets driver app on a phone/ });
    expect(pictures).toHaveLength(3);
    for (const picture of pictures) {
      // A capture, not a drawing of the app: an <img>, so nothing in it can
      // be focused or operated, and its reserved size prevents layout shift.
      expect(picture.tagName).toBe("IMG");
      expect(picture.getAttribute("width")).not.toBeNull();
      expect(picture.getAttribute("height")).not.toBeNull();
    }
  });

  test("the paper timesheet and the review card beside the hero phone are decoration, hidden from assistive technology", () => {
    renderRoute(PATHS.home);
    const hero = screen.getByRole("region", { name: "Driver timesheets without the paperwork." });
    for (const text of ["Daily timesheet", "I confirm all details are correct"]) {
      const piece = within(hero).getByText(text).closest('[aria-hidden="true"]');
      expect(piece, text).not.toBeNull();
      expect(piece?.querySelector("a, button, input, [tabindex]"), text).toBeNull();
    }
    // Only the phone is announced, as one described image.
    expect(within(hero).getAllByRole("img")).toHaveLength(1);
  });

  test("a skip link leads to the main content", () => {
    renderRoute(PATHS.home);
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip.getAttribute("href")).toBe("#main");
    expect(document.getElementById("main")?.tagName).toBe("MAIN");
  });
});
