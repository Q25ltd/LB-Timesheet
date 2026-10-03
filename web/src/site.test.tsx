import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { PATHS, SECTION } from "./paths";
import { renderRoute } from "./test/renderRoute";

/**
 * The site's structural promises, each checked against the real route table:
 * no link is broken, the unfinished company entry points say they are
 * unfinished and pretend nothing, and every page is navigable by heading and
 * by accessible name.
 */

const PAGES = [PATHS.home, PATHS.register, PATHS.login, PATHS.forgotPassword, PATHS.verifyEmail, PATHS.resetPassword] as const;

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

        // Nothing on this site links away from it: no social account,
        // partner or legal page exists to link to.
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
    for (const expected of [`/#${SECTION.howItWorks}`, PATHS.register, PATHS.login]) {
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
  // Every way into account registration or sign-in that the site offers.
  const ENTRY_POINTS = [
    { name: "Get started", path: PATHS.register },
    { name: "Log in", path: PATHS.login },
    { name: "Company login", path: PATHS.login },
  ] as const;

  test.each(ENTRY_POINTS)("$name leads to $path", ({ name, path }) => {
    renderRoute(PATHS.home);
    const links = screen.getAllByRole("link", { name });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute("href")).toBe(path);
  });

  test("/register registers a COMPANY — company details and administrator details on one form", () => {
    renderRoute(PATHS.register);
    expect(pageHeading()).toBe("Register your company");
    for (const label of ["Company name", "First name", "Last name", "Email", "Password", "Repeat password"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
    expect(robotsMeta()).toBe("noindex");
  });

  test("/login is the sign-in form", () => {
    renderRoute(PATHS.login);
    expect(pageHeading()).toBe("Sign in");
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

  test("the driver-app pictures are described images, never controls that do nothing", () => {
    renderRoute(PATHS.home);
    const pictures = screen.getAllByRole("img", { name: /^The Timesheets driver app on a phone/ });
    expect(pictures).toHaveLength(2);
    for (const picture of pictures) {
      // Their contents LOOK like buttons ("Finish Shift"); nothing in them
      // may be focusable or operable, and all of it is hidden from assistive
      // technology so no one is offered a control that does nothing.
      expect(picture.querySelector("a, button, input, [tabindex]")).toBeNull();
      expect(within(picture).queryByText("Finish Shift", { ignore: '[aria-hidden="true"] *' })).toBeNull();
    }
  });

  test("a skip link leads to the main content", () => {
    renderRoute(PATHS.home);
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip.getAttribute("href")).toBe("#main");
    expect(document.getElementById("main")?.tagName).toBe("MAIN");
  });
});
