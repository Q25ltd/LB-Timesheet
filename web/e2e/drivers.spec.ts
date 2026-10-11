import { expect, test, type Page } from "@playwright/test";

/**
 * D63, stage 4 — the Drivers page in a real browser against the real API on
 * another origin: add a driver, correct the invitation, cancel it.
 *
 * Written after the fake-API unit tests passed while the browser itself would
 * have refused the correction: the API's CORS allowed GET, HEAD and POST
 * only, so the PATCH never got past its preflight. Only a real browser and a
 * real API on two origins see that.
 */

const WEB = "http://localhost:4175";

// Its own client, as Railway's edge would name it (F-15): the suite registers
// more companies than one client's 5 per hour, and this spec is one more.
test.use({ extraHTTPHeaders: { "x-real-ip": "198.51.100.24" } });
const PASSWORD = "correct-horse-battery-staple";
const RUN = Date.now().toString(36);

function emailFor(label: string): string {
  return `e2e-${RUN}-${label}@example.com`;
}

async function registeredCompany(page: Page, email: string, companyName: string): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Company name").fill(companyName);
  await page.getByLabel("Time zone").selectOption("Europe/Vilnius");
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

test("a company adds a driver, corrects the invitation and cancels it — through the real API", async ({ page }) => {
  await registeredCompany(page, emailFor("drivers-admin"), "E2E Drivers Haulage UAB");

  // Home's next step leads to Drivers, as does the navigation.
  await page.getByRole("region", { name: "Getting started" }).getByRole("link", { name: "Go to Drivers" }).click();
  await expect(page).toHaveURL(`${WEB}/company/drivers`);
  await expect(page.getByRole("heading", { level: 1, name: "Drivers", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Company" }).getByRole("link", { name: "Drivers", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No drivers yet. Add your first driver above.")).toBeVisible();

  const driverEmail = emailFor("driver");
  await page.getByLabel("First name").fill("John");
  await page.getByLabel("Last name").fill("Smith");
  await page.getByLabel("Email address").fill(driverEmail);
  await page.getByLabel("Payroll or employee reference (optional)").fill("EMP-7");
  await page.getByRole("button", { name: "Add driver" }).click();
  await expect(page.getByRole("status")).toContainText("You have invited John Smith");

  const table = page.getByRole("table", { name: "Your drivers" });
  const row = table.getByRole("row").filter({ hasText: driverEmail });
  await expect(row).toContainText("John Smith");
  await expect(row).toContainText("EMP-7");
  await expect(row).toContainText("Invited");

  // Correct the name — a PATCH, cross-origin.
  await row.getByRole("button", { name: "Edit John Smith" }).click();
  await page.getByLabel("Edit first name").fill("Jon");
  await page.getByRole("button", { name: "Save changes" }).click();
  const corrected = table.getByRole("row").filter({ hasText: driverEmail });
  await expect(corrected).toContainText("Jon Smith");
  await expect(corrected).toContainText("Invited");

  // Cancel — asked first.
  await corrected.getByRole("button", { name: "Cancel invitation for Jon Smith" }).click();
  await corrected.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(table.getByRole("row").filter({ hasText: driverEmail })).toContainText("Cancelled");
  await expect(table.getByRole("row").filter({ hasText: driverEmail }).getByRole("button")).toHaveCount(0);

  // A reload: the list is the server's, not the page's memory.
  await page.reload();
  await expect(page.getByRole("table", { name: "Your drivers" }).getByRole("row").filter({ hasText: driverEmail })).toContainText("Cancelled");
});
