/**
 * The Home greeting and date — decorative chrome, proven at its boundaries.
 *
 * These are PURE functions over a supplied `Date`, which is the whole point:
 * the boundaries below are asserted against fixed local instants, so the same
 * assertions hold on any machine, in any zone, at any time of day. Nothing
 * here reads a clock, and nothing here touches the API.
 *
 * WHAT THIS IS NOT, and the confusion it exists to prevent: this date is the
 * DEVICE's local date, shown to be friendly. It is not `Shift.shiftDate`,
 * which is the company's local calendar date derived server-side from
 * `Company.timezone` (D18). The two must never be computed by the same code,
 * because one is decoration and the other is the filing date of a legal
 * record.
 */
import { formatHomeDate, salutationFor } from "../screens/homeGreeting";

// `new Date(y, m, d, h, min)` builds a LOCAL instant, so these cases mean the
// same wall-clock time wherever the suite runs. An ISO string would not: it
// would be parsed as UTC and shift by the runner's offset.
function at(hour: number, minute = 0): Date {
  return new Date(2026, 8, 7, hour, minute);
}

// ═══════════════════════════════════════════════════════════════════════════
// Greeting boundaries — stated explicitly, because they are a choice
// ═══════════════════════════════════════════════════════════════════════════
//
//   00:00 – 11:59   Good morning
//   12:00 – 17:59   Good afternoon
//   18:00 – 23:59   Good evening

test("midnight to 11:59 is morning, and 12:00 is NOT", () => {
  expect(salutationFor(at(0, 0))).toBe("Good morning");
  expect(salutationFor(at(5, 30))).toBe("Good morning");
  expect(salutationFor(at(11, 59))).toBe("Good morning");
  expect(salutationFor(at(12, 0))).not.toBe("Good morning");
});

test("12:00 to 17:59 is afternoon, on both edges", () => {
  expect(salutationFor(at(12, 0))).toBe("Good afternoon");
  expect(salutationFor(at(17, 59))).toBe("Good afternoon");
  // The edges are asserted from BOTH sides, so moving a boundary by one hour
  // cannot leave this file green.
  expect(salutationFor(at(11, 59))).not.toBe("Good afternoon");
  expect(salutationFor(at(18, 0))).not.toBe("Good afternoon");
});

test("18:00 to 23:59 is evening, on both edges", () => {
  expect(salutationFor(at(18, 0))).toBe("Good evening");
  expect(salutationFor(at(23, 59))).toBe("Good evening");
  expect(salutationFor(at(17, 59))).not.toBe("Good evening");
});

test("a driver's 04:45 start is still morning — the common case for this product", () => {
  expect(salutationFor(at(4, 45))).toBe("Good morning");
});

// ═══════════════════════════════════════════════════════════════════════════
// The date line
// ═══════════════════════════════════════════════════════════════════════════

test("the date renders as weekday, day, month and year, with no leading zero", () => {
  expect(formatHomeDate(new Date(2026, 8, 7))).toBe("Monday, 7 September 2026");
});

test("the format is stable across the year's edges and every weekday name", () => {
  expect(formatHomeDate(new Date(2026, 0, 1))).toBe("Thursday, 1 January 2026");
  expect(formatHomeDate(new Date(2026, 11, 31))).toBe("Thursday, 31 December 2026");
  expect(formatHomeDate(new Date(2026, 8, 12))).toBe("Saturday, 12 September 2026");
});

test("the time of day does not change the date line", () => {
  // Guards against a formatter that accidentally rolls over: 23:59 and 00:01
  // on the same calendar day must read identically.
  expect(formatHomeDate(new Date(2026, 8, 7, 0, 1))).toBe("Monday, 7 September 2026");
  expect(formatHomeDate(new Date(2026, 8, 7, 23, 59))).toBe("Monday, 7 September 2026");
});
