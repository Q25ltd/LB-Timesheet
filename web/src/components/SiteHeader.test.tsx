import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { PATHS } from "../paths";
import { renderRoute } from "../test/renderRoute";

/**
 * The narrow-screen menu is a disclosure: one button, `aria-expanded` telling
 * the truth, `aria-controls` naming the panel that holds the navigation.
 * (Whether the panel is visible at a given width is CSS, verified in a real
 * browser; this holds the state and keyboard contract.)
 */
function toggle() {
  return screen.getByRole("button", { name: /^(Menu|Close)$/ });
}

/** The panel the button controls — found through the button, not by id. */
function menuPanel(): HTMLElement {
  const panel = document.getElementById(toggle().getAttribute("aria-controls") ?? "");
  if (panel === null) throw new Error("the menu button controls no element");
  return panel;
}

describe("site menu", () => {
  test("controls the panel that holds the main navigation, and starts closed", () => {
    renderRoute(PATHS.home);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const panel = menuPanel();
    expect(within(panel).getByRole("navigation", { name: "Main" })).toBeDefined();
    expect(within(panel).getByRole("link", { name: "Log in" })).toBeDefined();
    expect(within(panel).getByRole("link", { name: "Get started" })).toBeDefined();
  });

  test("opens, and says Close while open", () => {
    renderRoute(PATHS.home);
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().textContent).toBe("Close");
    expect(document.querySelector(".site-header")?.getAttribute("data-menu-open")).toBe("true");
  });

  test("Escape closes it and returns focus to the button", () => {
    renderRoute(PATHS.home);
    fireEvent.click(toggle());
    within(menuPanel()).getByRole("link", { name: "Features" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle());
  });

  test("following a link in it closes it", async () => {
    renderRoute(PATHS.home);
    fireEvent.click(toggle());
    fireEvent.click(within(menuPanel()).getByRole("link", { name: "Log in" }));
    await screen.findByRole("heading", { level: 1, name: "Company login is not available yet" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  test("other keys leave it open", () => {
    renderRoute(PATHS.home);
    fireEvent.click(toggle());
    fireEvent.keyDown(document, { key: "Tab" });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });
});
