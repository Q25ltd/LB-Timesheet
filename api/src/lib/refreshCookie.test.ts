import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearedRefreshCookie,
  readRefreshCookie,
  refreshCookie,
  refreshCookiePolicy,
} from "./refreshCookie.js";

const SECRET = "Qm9vdHN0cmFwLXJlZnJlc2gtc2VjcmV0LTMyLWJ5dGVz_-a";
const NOW = new Date("2026-10-01T12:00:00Z");

function attributes(header: string): string[] {
  return header.split(";").map(part => part.trim());
}

test("production — and an UNSET NODE_ENV — get the Secure, __Host- cookie", () => {
  for (const nodeEnv of ["production", undefined] as const) {
    const policy = refreshCookiePolicy(nodeEnv);
    assert.equal(policy.name, "__Host-lbts_refresh", `NODE_ENV=${String(nodeEnv)}`);
    assert.equal(policy.secure, true);

    const set = attributes(refreshCookie(policy, SECRET, new Date(NOW.getTime() + 3600_000), NOW));
    assert.equal(set[0], `__Host-lbts_refresh=${SECRET}`);
    // The three things `__Host-` makes the BROWSER insist on: Secure, Path=/, no Domain.
    assert.ok(set.includes("Secure"));
    assert.ok(set.includes("Path=/"));
    assert.ok(!set.some(a => a.toLowerCase().startsWith("domain")), "host-only: never a Domain attribute");
    assert.ok(set.includes("HttpOnly"));
    assert.ok(set.includes("SameSite=Strict"));
  }
});

test("development and test use a plain-http cookie with the same attributes minus Secure", () => {
  for (const nodeEnv of ["development", "test"] as const) {
    const policy = refreshCookiePolicy(nodeEnv);
    assert.equal(policy.name, "lbts_refresh");
    const set = attributes(refreshCookie(policy, SECRET, new Date(NOW.getTime() + 3600_000), NOW));
    assert.ok(!set.includes("Secure"));
    assert.ok(set.includes("HttpOnly"));
    assert.ok(!set.some(a => a.toLowerCase().startsWith("domain")));
  }
});

test("Max-Age is the session's remaining lifetime, rounded DOWN, and never negative", () => {
  const policy = refreshCookiePolicy("test");
  assert.ok(attributes(refreshCookie(policy, SECRET, new Date(NOW.getTime() + 7 * 86_400_000), NOW)).includes("Max-Age=604800"));
  assert.ok(attributes(refreshCookie(policy, SECRET, new Date(NOW.getTime() + 1999), NOW)).includes("Max-Age=1"));
  assert.ok(attributes(refreshCookie(policy, SECRET, new Date(NOW.getTime() - 5000), NOW)).includes("Max-Age=0"));
  assert.ok(attributes(clearedRefreshCookie(policy)).includes("Max-Age=0"));
  assert.equal(attributes(clearedRefreshCookie(policy))[0], "lbts_refresh=");
});

test("the reader returns the ONE credential of our name, and null for anything ambiguous or malformed", () => {
  const policy = refreshCookiePolicy("test");
  assert.equal(readRefreshCookie(`lbts_refresh=${SECRET}`, policy), SECRET);
  assert.equal(readRefreshCookie(`theme=dark; lbts_refresh=${SECRET}; other=1`, policy), SECRET);

  assert.equal(readRefreshCookie(undefined, policy), null);
  assert.equal(readRefreshCookie("", policy), null);
  assert.equal(readRefreshCookie("theme=dark", policy), null);
  assert.equal(readRefreshCookie(`lbts_refresh=${SECRET}; lbts_refresh=${SECRET}`, policy), null, "a duplicate is what a tossed cookie looks like");
  assert.equal(readRefreshCookie("lbts_refresh=", policy), null);
  assert.equal(readRefreshCookie("lbts_refresh=has space", policy), null);
  assert.equal(readRefreshCookie(`lbts_refresh=${"a".repeat(65)}`, policy), null);
  // The production reader does not accept the development name, nor the reverse.
  assert.equal(readRefreshCookie(`lbts_refresh=${SECRET}`, refreshCookiePolicy("production")), null);
  assert.equal(readRefreshCookie(`__Host-lbts_refresh=${SECRET}`, policy), null);
});
