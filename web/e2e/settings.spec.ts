import { expect, test, type Page } from "@playwright/test";

/**
 * D66, stage S1 — Settings in a real browser against the real API on another
 * origin: the units a company chose at registration, changed with a PUT
 * (which a browser asks the API's CORS about first — the fake-API tests cannot
 * see that), and kept across a reload.
 */

const WEB = "http://localhost:4175";

// Its own client, as Railway's edge would name it (F-15).
test.use({ extraHTTPHeaders: { "x-real-ip": "198.51.100.26" } });
const PASSWORD = "correct-horse-battery-staple";
const RUN = Date.now().toString(36);

async function registeredCompany(page: Page, email: string): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Company name").fill("E2E Units Haulage UAB");
  await page.getByLabel("Time zone").selectOption("Europe/Vilnius");
  await page.getByLabel("Distance unit").selectOption("kilometre");
  await page.getByLabel("Fuel unit").selectOption("litre");
  await page.getByLabel("First name").fill("Edith");
  await page.getByLabel("Last name").fill("Owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repeat password").fill(PASSWORD);
  await page.getByRole("button", { name: "Register company" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Check your email", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open verification link", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your company is registered", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(`${WEB}/company`);
}

test("D66: the units chosen at registration are the company's; Settings changes them through the real API, and they are kept", async ({ page }) => {
  await registeredCompany(page, `e2e-${RUN}-units@example.com`);

  // Chosen at registration: Home has nothing to ask.
  await expect(page.getByRole("heading", { level: 2, name: "Getting started" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Choose your measurement units" })).toHaveCount(0);

  await page.getByRole("navigation", { name: "Company" }).getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(`${WEB}/company/settings`);
  await expect(page.getByLabel("Distance unit")).toHaveValue("kilometre");
  await expect(page.getByLabel("Fuel unit")).toHaveValue("litre");

  // A PUT, cross-origin.
  await page.getByLabel("Distance unit").selectOption("mile");
  await page.getByLabel("Fuel unit").selectOption("us_gallon");
  await page.getByRole("button", { name: "Save units" }).click();
  await expect(page.getByRole("status")).toContainText("Units saved");

  await page.reload();
  await expect(page.getByLabel("Distance unit")).toHaveValue("mile");
  await expect(page.getByLabel("Fuel unit")).toHaveValue("us_gallon");
});
