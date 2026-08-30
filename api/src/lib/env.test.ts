import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvSchema, describeEnvFailure } from "./env.schema.js";

const valid = {
  DATABASE_URL: "postgresql://app:app@localhost:5544/lb_timesheet",
  JWT_SECRET:   "x".repeat(32),
};

test("accepts a minimal valid environment and applies defaults", () => {
  const parsed = EnvSchema.parse(valid);
  assert.equal(parsed.PORT, 3000);
  assert.equal(parsed.NODE_ENV, "development");
  assert.equal(parsed.SENDGRID_API_KEY, "");
  assert.equal(parsed.MAIL_FROM, "timesheets@logisticbay.com");
});

test("rejects a JWT_SECRET shorter than 32 characters", () => {
  const result = EnvSchema.safeParse({ ...valid, JWT_SECRET: "too-short" });
  assert.equal(result.success, false);
  assert.match(describeEnvFailure(result.error), /JWT_SECRET must be at least 32 characters/);
});

test("rejects a missing DATABASE_URL", () => {
  const { DATABASE_URL: _omitted, ...withoutUrl } = valid;
  const result = EnvSchema.safeParse(withoutUrl);
  assert.equal(result.success, false);
  assert.match(describeEnvFailure(result.error), /DATABASE_URL/);
});

test("rejects an unknown NODE_ENV", () => {
  assert.equal(EnvSchema.safeParse({ ...valid, NODE_ENV: "staging" }).success, false);
});

test("coerces PORT from a string", () => {
  assert.equal(EnvSchema.parse({ ...valid, PORT: "8080" }).PORT, 8080);
});

test("describeEnvFailure lists every problem, not just the first", () => {
  const result = EnvSchema.safeParse({ JWT_SECRET: "short" });
  assert.equal(result.success, false);
  const described = describeEnvFailure(result.error);
  assert.match(described, /DATABASE_URL/);
  assert.match(described, /JWT_SECRET/);
});
