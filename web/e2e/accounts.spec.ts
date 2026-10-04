import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { resetLinkSentTo } from "./mailbox";

/**
 * The company web authentication flows, end to end, in a real browser
 * against the real API and a real database (owner decision B8).
 *
 * Every name and text assertion is EXACT. Playwright matches substrings by
 * default, and an inexact wait once passed before a registration had
 * finished.
 *
 * Companies register through the REAL page (D51): Register your company →
 * Check your email → "Open verification link" in its Development email
 * section — the exact link the development outbox's message contains (the
 * API writes every message to `api/.mail-outbox/`; no provider is involved)
 * → Your company is registered → sign in. This suite reads the outbox
 * directly only for password-reset links, which have no such helper.
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

/** Register a company through the real page, as an administrator does. */
async function registerThroughThePage(page: Page, email: string, companyName: string): Promise<void> {
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
}

/** The verification link, as Check your email's development section offers it. */
async function developmentLink(page: Page): Promise<string> {
  const open = page.getByRole("region", { name: "Development email" }).getByRole("link", { name: "Open verification link", exact: true });
  await expect(open).toHaveAttribute("href", /^http:\/\/localhost:4175\/verify-email#token=[A-Za-z0-9_-]+$/);
  return String(await open.getAttribute("href"));
}

/** Register, then complete it with the emailed link — the company exists. */
async function registeredCompany(page: Page, email: string, companyName: string): Promise<void> {
  await registerThroughThePage(page, email, companyName);
  await page.getByRole("link", { name: "Open verification link", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your company is registered", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Continue", exact: true }).click();
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

test("a company registers, confirms its email, reaches its company, signs out and signs in again", async ({ page, context, request }) => {
  const email = emailFor("owner");
  await registerThroughThePage(page, email, "E2E Vilnius Haulage UAB");
  await expect(page.getByText("To finish registering E2E Vilnius Haulage UAB, confirm the administrator's email address: " + email + ".", { exact: true })).toBeVisible();

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

  // A reload forgets every in-memory token; the cookie restores the
  // restricted state — still Check your email, nothing else.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Check your email", exact: true })).toBeVisible();

  // The emailed link, opened in this browser from Check your email's
  // development section: the company is created, the token consumed and
  // removed from the address bar.
  const link = await developmentLink(page);
  await page.getByRole("link", { name: "Open verification link", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your company is registered", exact: true })).toBeVisible();
  expect(page.url()).toBe(`${WEB}/verify-email`);
  await page.getByRole("link", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your account", exact: true })).toBeVisible();
  await expect(page.getByText("Set up a company", { exact: true })).toHaveCount(0);

  // The link is single-use.
  await page.goto(link);
  await expect(page.getByRole("heading", { level: 1, name: "This link has expired or was already used", exact: true })).toBeVisible();

  await page.goto("/account");
  await page.getByRole("button", { name: "Open E2E Vilnius Haulage UAB" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "E2E Vilnius Haulage UAB", exact: true })).toBeVisible();

  const lastSecret = (await refreshCookie(context))?.value;
  expect(lastSecret).toBeTruthy();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("You have signed out.", { exact: true })).toBeVisible();
  expect(await refreshCookie(context), "the browser was told to drop the cookie").toBeUndefined();

  // Server-side, the session is gone: the last cookie value no longer works.
  const replay = await request.post(`${API}/auth/web/refresh`, { headers: { origin: WEB, cookie: `lbts_refresh=${String(lastSecret)}` } });
  expect(replay.status()).toBe(401);

  // Signing in again goes straight to the one company (D13).
  await signIn(page, email, PASSWORD);
  await expect(page.getByRole("heading", { level: 1, name: "E2E Vilnius Haulage UAB", exact: true })).toBeVisible();
});

test("a pending registration signs in to Check your email, and a new link replaces the old one", async ({ page, browser }) => {
  const email = emailFor("pending");
  await registerThroughThePage(page, email, "E2E Pending Freight");
  await page.getByRole("button", { name: "Sign out" }).click();

  const elsewhere = await browser.newContext();
  const other = await elsewhere.newPage();
  await signIn(other, email, PASSWORD);
  await expect(other.getByRole("heading", { level: 1, name: "Check your email", exact: true })).toBeVisible();
  const firstLink = await developmentLink(other);
  await other.getByRole("button", { name: "Send a new link" }).click();
  await expect(other.getByText(`We have sent a new link to ${email}.`, { exact: true })).toBeVisible();

  // The page now offers the NEW link, never the superseded one.
  await expect(other.getByRole("link", { name: "Open verification link", exact: true })).not.toHaveAttribute("href", firstLink);
  const secondLink = await developmentLink(other);

  // The first link was superseded by the second. Each opened as an email
  // client opens one: in a tab of its own.
  const first = await elsewhere.newPage();
  await first.goto(firstLink);
  await expect(first.getByRole("heading", { level: 1, name: "This link has expired or was already used", exact: true })).toBeVisible();
  const second = await elsewhere.newPage();
  await second.goto(secondLink);
  await expect(second.getByRole("heading", { level: 1, name: "Your company is registered", exact: true })).toBeVisible();
  await elsewhere.close();
});

test("a password reset in another browser signs this one out; the old password stops working", async ({ page, browser }) => {
  const email = emailFor("reset");
  await registeredCompany(page, email, "E2E Reset Freight");

  const elsewhere = await browser.newContext();
  const other = await elsewhere.newPage();
  await other.goto(`${WEB}/forgot-password`);
  await other.getByLabel("Email").fill(email);
  await other.getByRole("button", { name: "Send reset link" }).click();
  await expect(other.getByText("If that address has an account, a reset link is on its way.", { exact: false })).toBeVisible();
  await other.goto(await resetLinkSentTo(email));
  await other.getByLabel("New password", { exact: true }).fill("a-brand-new-passphrase");
  await other.getByLabel("Repeat new password").fill("a-brand-new-passphrase");
  await other.getByRole("button", { name: "Save new password" }).click();
  await expect(other.getByRole("heading", { level: 1, name: "Your password has been changed", exact: true })).toBeVisible();
  await elsewhere.close();

  // Every session was revoked — including this browser's.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Company sign-in", exact: true })).toBeVisible();

  await signIn(page, email, PASSWORD);
  await expect(page.getByText("Email or password is incorrect.", { exact: true })).toBeVisible();
  await signIn(page, email, "a-brand-new-passphrase");
  await expect(page.getByRole("heading", { level: 1, name: "E2E Reset Freight", exact: true })).toBeVisible();
});

test("changing the password keeps THIS browser signed in and signs the other one out", async ({ page, browser }) => {
  const email = emailFor("change");
  await registeredCompany(page, email, "E2E Change Freight");

  const elsewhere = await browser.newContext();
  const other = await elsewhere.newPage();
  await signIn(other, email, PASSWORD);
  await expect(other.getByRole("heading", { level: 1, name: "E2E Change Freight", exact: true })).toBeVisible();

  await page.getByLabel("Current password").fill(PASSWORD);
  await page.getByLabel("New password", { exact: true }).fill("another-new-passphrase");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Your password has been changed.", { exact: false })).toBeVisible();

  await other.reload();
  await expect(other.getByRole("heading", { level: 1, name: "Company sign-in", exact: true })).toBeVisible();
  await elsewhere.close();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Your account", exact: true })).toBeVisible();
});

test("signed-out visitors are sent to sign in, and a wrong password is one generic message", async ({ page }) => {
  for (const path of ["/account", "/company"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Company sign-in", exact: true })).toBeVisible();
  }
  await signIn(page, emailFor("nobody"), "whatever-password");
  await expect(page.getByText("Email or password is incorrect.", { exact: true })).toBeVisible();
});
