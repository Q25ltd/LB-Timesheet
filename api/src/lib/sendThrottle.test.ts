import { test } from "node:test";
import assert from "node:assert/strict";
import { sendThrottle } from "./sendThrottle.js";

const HOUR = 60 * 60 * 1000;

test("three per address per hour, then refused until the window slides", () => {
  let clock = 0;
  const throttle = sendThrottle({ max: 3, windowMs: HOUR, now: () => clock });
  assert.deepEqual([1, 2, 3, 4].map(() => throttle.allow("a@example.com")), [true, true, true, false]);
  assert.equal(throttle.allow("b@example.com"), true, "addresses are counted separately");

  clock = HOUR - 1;
  assert.equal(throttle.allow("a@example.com"), false, "still inside the hour");
  clock = HOUR;
  assert.equal(throttle.allow("a@example.com"), true, "the oldest request has left the window");
});

test("memory is bounded: past maxTracked the oldest addresses are forgotten", () => {
  const throttle = sendThrottle({ max: 1, windowMs: HOUR, maxTracked: 2, now: () => 0 });
  assert.equal(throttle.allow("one"), true);
  assert.equal(throttle.allow("two"), true);
  assert.equal(throttle.allow("three"), true);
  assert.equal(throttle.allow("three"), false);
  assert.equal(throttle.allow("one"), true, "the oldest entry was evicted, not kept forever");
});
