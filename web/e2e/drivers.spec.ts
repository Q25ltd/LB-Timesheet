import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { verificationTokenSentTo } from "./mailbox";

/**
 * D63, stage 4, and D65 — the Drivers page in a real browser against the
 * real API on another origin: add a driver, correct the invitation, cancel
 * it; and, once a driver has joined, deactivate, reactivate and remove them.
 *
 * Written after the fake-API unit tests passed while the browser itself would
 * have refused the correction: the API's CORS allowed GET, HEAD and POST
 * only, so the PATCH never got past its preflight. Only a real browser and a
 * real API on two origins see that.
 */

const WEB = "http://localhost:4175";
const API = "http://localhost:3100";

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

  const table = page.getByRole("table", { name: "Invitations" });
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
  await expect(page.getByRole("table", { name: "Invitations" }).getByRole("row").filter({ hasText: driverEmail })).toContainText("Cancelled");
});

/** A driver, as the phone app would be: registered, email confirmed, invitation accepted — straight to the API. */
async function driverAccepts(request: APIRequestContext, email: string): Promise<void> {
  const headers = { "x-real-ip": "198.51.100.25" };
  const registered = await request.post(`${API}/auth/register`, { headers, data: { firstName: "Dee", lastName: "River", email, password: PASSWORD } });
  expect(registered.status()).toBe(201);
  const body: unknown = await registered.json();
  const token = typeof body === "object" && body !== null && "identityToken" in body && typeof body.identityToken === "string" ? body.identityToken : "";
  const auth = { ...headers, authorization: `Bearer ${token}` };
  expect((await request.post(`${API}/auth/email-verification`, { headers: auth })).status()).toBe(204);
  const confirmed = await request.post(`${API}/auth/email-verification/confirm`, { headers, data: { token: await verificationTokenSentTo(email) } });
  expect(confirmed.status()).toBe(200);
  const open: unknown = await (await request.get(`${API}/driver/invitations`, { headers: auth })).json();
  const invitations = typeof open === "object" && open !== null && "invitations" in open && Array.isArray(open.invitations) ? open.invitations as unknown[] : [];
  const first = invitations[0];
  const id = typeof first === "object" && first !== null && "id" in first && typeof first.id === "string" ? first.id : "";
  expect((await request.post(`${API}/driver/invitations/${id}/accept`, { headers: auth })).status()).toBe(200);
}

test("D65: a driver who joined is deactivated, reactivated and removed — each asked first where it matters — through the real API", async ({ page, request }) => {
  await registeredCompany(page, emailFor("members-admin"), "E2E Members Haulage UAB");
  await page.goto("/company/drivers");

  const driverEmail = emailFor("member");
  await page.getByLabel("First name").fill("Dee");
  await page.getByLabel("Last name").fill("River");
  await page.getByLabel("Email address").fill(driverEmail);
  await page.getByRole("button", { name: "Add driver" }).click();
  await expect(page.getByRole("status")).toContainText("You have invited Dee River");

  await driverAccepts(request, driverEmail);
  await page.reload();

  const members = page.getByRole("table", { name: "Your drivers" });
  const row = members.getByRole("row").filter({ hasText: driverEmail });
  await expect(row).toContainText("Active");
  await expect(page.getByRole("table", { name: "Invitations" })).toHaveCount(0);

  await row.getByRole("button", { name: "Deactivate Dee River" }).click();
  await row.getByRole("button", { name: "Yes, deactivate" }).click();
  await expect(row).toContainText("Deactivated");
  await expect(page.getByRole("status")).toContainText("Dee River is deactivated");

  await row.getByRole("button", { name: "Reactivate Dee River" }).click();
  await expect(row).not.toContainText("Deactivated");
  await expect(row).toContainText("Active");

  await row.getByRole("button", { name: "Remove Dee River" }).click();
  await row.getByRole("button", { name: "Yes, remove" }).click();
  await expect(page.getByRole("status")).toContainText("Dee River is removed");
  await expect(page.getByRole("table", { name: "Your drivers" })).toHaveCount(0);

  // A reload: the server's list, not the page's memory.
  await page.reload();
  await expect(page.getByText("No drivers yet. Add your first driver above.")).toBeVisible();
});
