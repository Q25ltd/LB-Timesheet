import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { linkSentTo } from "./mailbox";

/**
 * The company web authentication flows, end to end, in a real browser
 * against the real API and a real database (owner decision B8).
 *
 * Every name and text assertion is EXACT. Playwright matches substrings by
 * default, and "Your account" is a substring of the registration page's own
 * heading, "Create your account" — an inexact wait passed before the
 * registration had finished.
 *
 * Registrations per run stay within the API's 5-per-hour-per-IP limit (D50):
 * every browser here shares 127.0.0.1.
 */
const API = "http://localhost:3100";
const WEB = "http://localhost:4175";
const PASSWORD = "correct-horse-battery-staple";
const RUN = Date.now().toString(36);

function emailFor(label: string): string {
  return `e2e-${RUN}-${label}@example.com`;
}

async function register(page: Page, email: string): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("First name").fill("Edith");
  await page.getByLabel("Last name").fill("Owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repeat password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your account", exact: true })).toBeVisible();
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function refreshCookie(context: BrowserContext) {
  return (await context.cookies(API)).find(cookie => cookie.name === "lbts_refresh");
}

test("a company owner: register, confirm the email, survive a reload, set up companies, choose one, sign out", async ({ page, context, request }) => {
  const email = emailFor("owner");
  await register(page, email);
  await expect(page.getByText("Email address not confirmed", { exact: true })).toBeVisible();
  await expect(page.getByText("Confirm your email address first.", { exact: true })).toBeVisible();

  // Where the credentials live: nothing in page-readable storage; the refresh
  // secret only in an HttpOnly, SameSite=Strict, host-only cookie.
  // Reading the page's stores to prove they are EMPTY — the inverse of what
  // the storage ban guards against, so the ban is lifted for this one line.
  /* eslint-disable no-restricted-globals, no-restricted-properties -- asserts the stores are EMPTY (D45) */
  const storage = await page.evaluate(() => ({
    local: localStorage.length, session: sessionStorage.length, cookie: document.cookie,
  }));
  /* eslint-enable no-restricted-globals, no-restricted-properties */
  expect(storage).toEqual({ local: 0, session: 0, cookie: "" });
  const cookie = await refreshCookie(context);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  expect(cookie?.domain).toBe("localhost");

  // The emailed link, opened in this browser: the token is consumed and
  // removed from the address bar.
  await page.goto(await linkSentTo(email, "verify-email"));
  await expect(page.getByText("Your email address is confirmed.", { exact: true })).toBeVisible();
  expect(page.url()).toBe(`${WEB}/verify-email`);

  // A reload forgets every in-memory token; the cookie restores the session.
  await page.goto("/account");
  await page.reload();
  await expect(page.getByText("Email address confirmed", { exact: true })).toBeVisible();

  for (const name of ["E2E Haulage One", "E2E Haulage Two"]) {
    await page.getByLabel("Company name").fill(name);
    await page.getByRole("button", { name: "Set up company" }).click();
    await expect(page.getByRole("button", { name: `Open ${name}` })).toBeVisible();
  }

  await page.getByRole("button", { name: "Open E2E Haulage Two" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "E2E Haulage Two", exact: true })).toBeVisible();
  await expect(page.getByText("The company workspace is the next stage of development and is not available yet.", { exact: true })).toBeVisible();

  // Tenant authority is memory-only: a reload returns to choosing a company.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Your account", exact: true })).toBeVisible();

  const lastSecret = (await refreshCookie(context))?.value;
  expect(lastSecret).toBeTruthy();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("You have signed out.", { exact: true })).toBeVisible();
  expect(await refreshCookie(context), "the browser was told to drop the cookie").toBeUndefined();

  // Server-side, the session is gone: the last cookie value no longer works.
  const replay = await request.post(`${API}/auth/web/refresh`, { headers: { origin: WEB, cookie: `lbts_refresh=${String(lastSecret)}` } });
  expect(replay.status()).toBe(401);

  await page.goto("/account");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();
});

test("a password reset in another browser signs this one out; the old password stops working", async ({ page, browser }) => {
  const email = emailFor("reset");
  await register(page, email);

  const elsewhere = await browser.newContext();
  const other = await elsewhere.newPage();
  await other.goto(`${WEB}/forgot-password`);
  await other.getByLabel("Email").fill(email);
  await other.getByRole("button", { name: "Send reset link" }).click();
  await expect(other.getByText("If that address has an account, a reset link is on its way.", { exact: false })).toBeVisible();
  await other.goto(await linkSentTo(email, "reset-password"));
  await other.getByLabel("New password", { exact: true }).fill("a-brand-new-passphrase");
  await other.getByLabel("Repeat new password").fill("a-brand-new-passphrase");
  await other.getByRole("button", { name: "Save new password" }).click();
  await expect(other.getByRole("heading", { level: 1, name: "Your password has been changed", exact: true })).toBeVisible();
  await elsewhere.close();

  // Every session was revoked — including this browser's.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();

  await signIn(page, email, PASSWORD);
  await expect(page.getByText("Email or password is incorrect.", { exact: true })).toBeVisible();
  await signIn(page, email, "a-brand-new-passphrase");
  await expect(page.getByRole("heading", { level: 1, name: "Your account", exact: true })).toBeVisible();
});

test("changing the password keeps THIS browser signed in and signs the other one out", async ({ page, browser }) => {
  const email = emailFor("change");
  await register(page, email);

  const elsewhere = await browser.newContext();
  const other = await elsewhere.newPage();
  await signIn(other, email, PASSWORD);
  await expect(other.getByRole("heading", { level: 1, name: "Your account", exact: true })).toBeVisible();

  await page.getByLabel("Current password").fill(PASSWORD);
  await page.getByLabel("New password", { exact: true }).fill("another-new-passphrase");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Your password has been changed.", { exact: false })).toBeVisible();

  await other.reload();
  await expect(other.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();
  await elsewhere.close();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Your account", exact: true })).toBeVisible();
});

test("signed-out visitors are sent to sign in, and a wrong password is one generic message", async ({ page }) => {
  for (const path of ["/account", "/company"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();
  }
  await signIn(page, emailFor("nobody"), "whatever-password");
  await expect(page.getByText("Email or password is incorrect.", { exact: true })).toBeVisible();
});
