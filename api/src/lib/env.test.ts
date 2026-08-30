import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EnvSchema,
  describeEnvFailure,
  allowedOrigins,
  normaliseOrigin,
  splitOrigins,
  DEV_ORIGINS,
} from "./env.schema.js";

const valid = {
  DATABASE_URL: "postgresql://app:app@localhost:5544/lb_timesheet",
  JWT_SECRET:   "x".repeat(32),
};

const prod = { ...valid, NODE_ENV: "production", WEB_ORIGIN: "https://timesheets.logisticbay.com" };

// ── Base environment ─────────────────────────────────────────────────────────

test("accepts a minimal valid environment and applies defaults", () => {
  const parsed = EnvSchema.parse({ ...valid, NODE_ENV: "development" });
  assert.equal(parsed.PORT, 3000);
  assert.equal(parsed.NODE_ENV, "development");
  assert.equal(parsed.SENDGRID_API_KEY, "");
  assert.equal(parsed.MAIL_FROM, "timesheets@logisticbay.com");
});

test("rejects a JWT_SECRET shorter than 32 characters", () => {
  const result = EnvSchema.safeParse({ ...prod, JWT_SECRET: "too-short" });
  assert.equal(result.success, false);
  assert.match(describeEnvFailure(result.error), /JWT_SECRET must be at least 32 characters/);
});

test("rejects a missing DATABASE_URL", () => {
  const { DATABASE_URL: _omitted, ...withoutUrl } = prod;
  const result = EnvSchema.safeParse(withoutUrl);
  assert.equal(result.success, false);
  assert.match(describeEnvFailure(result.error), /DATABASE_URL/);
});

test("rejects an unknown NODE_ENV", () => {
  assert.equal(EnvSchema.safeParse({ ...prod, NODE_ENV: "staging" }).success, false);
});

test("coerces PORT from a string", () => {
  assert.equal(EnvSchema.parse({ ...prod, PORT: "8080" }).PORT, 8080);
});

test("describeEnvFailure lists every problem, not just the first", () => {
  const result = EnvSchema.safeParse({ JWT_SECRET: "short" });
  assert.equal(result.success, false);
  const described = describeEnvFailure(result.error);
  assert.match(described, /DATABASE_URL/);
  assert.match(described, /JWT_SECRET/);
});

// ── WEB_ORIGIN is required unless NODE_ENV is EXPLICITLY development/test ────

test("an UNSET NODE_ENV requires WEB_ORIGIN — a forgotten NODE_ENV must fail closed", () => {
  const result = EnvSchema.safeParse(valid);
  assert.equal(result.success, false, "missing NODE_ENV must not inherit dev defaults");
  assert.match(describeEnvFailure(result.error), /WEB_ORIGIN is required unless NODE_ENV/);
});

test("production without WEB_ORIGIN fails closed", () => {
  const result = EnvSchema.safeParse({ ...valid, NODE_ENV: "production" });
  assert.equal(result.success, false);
  assert.match(describeEnvFailure(result.error), /WEB_ORIGIN is required unless NODE_ENV/);
});

test("explicit development and test do NOT require WEB_ORIGIN", () => {
  assert.equal(EnvSchema.safeParse({ ...valid, NODE_ENV: "development" }).success, true);
  assert.equal(EnvSchema.safeParse({ ...valid, NODE_ENV: "test" }).success, true);
});

test("production accepts a valid https origin", () => {
  assert.equal(EnvSchema.safeParse(prod).success, true);
});

test("production rejects a wildcard, wildcard hosts, http, paths and trailing slashes", () => {
  for (const bad of [
    "*",
    "https://*.logisticbay.com",
    "http://timesheets.logisticbay.com",
    "https://timesheets.logisticbay.com/",
    "https://timesheets.logisticbay.com/app",
    "timesheets.logisticbay.com",
    "https://user:pass@timesheets.logisticbay.com",
  ]) {
    const result = EnvSchema.safeParse({ ...valid, NODE_ENV: "production", WEB_ORIGIN: bad });
    assert.equal(result.success, false, `should have been rejected: ${bad}`);
    assert.match(describeEnvFailure(result.error), /is not a usable origin/, `bad message for: ${bad}`);
  }
});

// ── allowedOrigins carries the guarantee itself ──────────────────────────────

test("allowedOrigins NEVER returns a wildcard, even in development", () => {
  assert.deepEqual(allowedOrigins({ WEB_ORIGIN: "*", NODE_ENV: "development" }), []);
  assert.deepEqual(allowedOrigins({ WEB_ORIGIN: "*", NODE_ENV: "test" }), []);
  assert.deepEqual(allowedOrigins({ WEB_ORIGIN: "https://*.evil.com", NODE_ENV: "development" }), []);
});

test("allowedOrigins returns [] when NODE_ENV is unset and nothing is configured", () => {
  assert.deepEqual(allowedOrigins({ WEB_ORIGIN: "" }), []);
  assert.deepEqual(allowedOrigins({ WEB_ORIGIN: "", NODE_ENV: "production" }), []);
});

test("development with no WEB_ORIGIN uses the explicit localhost defaults", () => {
  assert.deepEqual(allowedOrigins({ WEB_ORIGIN: "", NODE_ENV: "development" }), [...DEV_ORIGINS]);
});

test("an explicit WEB_ORIGIN list replaces the dev defaults", () => {
  assert.deepEqual(
    allowedOrigins({
      WEB_ORIGIN: "https://timesheets.logisticbay.com, https://admin.logisticbay.com",
      NODE_ENV: "production",
    }),
    ["https://timesheets.logisticbay.com", "https://admin.logisticbay.com"],
  );
});

test("allowedOrigins drops invalid entries rather than passing them through", () => {
  assert.deepEqual(
    allowedOrigins({ WEB_ORIGIN: "https://good.com, *, https://bad.com/path", NODE_ENV: "production" }),
    ["https://good.com"],
  );
});

test("http is allowed only on localhost, and only when dev-like", () => {
  assert.deepEqual(allowedOrigins({ WEB_ORIGIN: "http://localhost:3000", NODE_ENV: "development" }), ["http://localhost:3000"]);
  assert.deepEqual(allowedOrigins({ WEB_ORIGIN: "http://evil.com", NODE_ENV: "development" }), []);
  assert.deepEqual(allowedOrigins({ WEB_ORIGIN: "http://localhost:3000", NODE_ENV: "production" }), []);
});

// ── normaliseOrigin ──────────────────────────────────────────────────────────

test("normaliseOrigin canonicalises case and the default port", () => {
  const opts = { allowInsecureLocalhost: false };
  assert.equal(normaliseOrigin("https://A.Example.COM", opts), "https://a.example.com");
  assert.equal(normaliseOrigin("HTTPS://a.example.com", opts), "https://a.example.com");
  assert.equal(normaliseOrigin("https://a.example.com:443", opts), "https://a.example.com");
  assert.equal(normaliseOrigin("https://a.example.com:8443", opts), "https://a.example.com:8443");
});

test("normaliseOrigin rejects everything that is not scheme://host", () => {
  const opts = { allowInsecureLocalhost: true };
  for (const bad of ["*", "null", "", "   ", "https://*", "https://*.a.com",
                     "https://a.com/", "https://a.com/x", "https://a.com?q=1",
                     "https://a.com#f", "https://u:p@a.com", "a.com", "ftp://a.com"]) {
    assert.equal(normaliseOrigin(bad, opts), null, `should be rejected: ${JSON.stringify(bad)}`);
  }
});

test("splitOrigins trims whitespace and drops empty entries", () => {
  assert.deepEqual(splitOrigins(" https://a.com , https://b.com ,, "), ["https://a.com", "https://b.com"]);
  assert.deepEqual(splitOrigins(""), []);
  assert.deepEqual(splitOrigins("   "), []);
});
