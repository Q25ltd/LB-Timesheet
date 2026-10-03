/**
 * D18's timezone semantics, proven purely — the conversion Start Shift will
 * depend on when it derives `Shift.shiftDate` from the start instant and the
 * company's timezone. No Shift, no route, no database: this file proves the
 * mechanism, and src/tests/db/companyTimezone.test.ts proves the authority it
 * reads is persisted.
 *
 * Every case here is a boundary that has a wrong answer available: a local
 * date that differs from the UTC date, two companies filing the same instant
 * under different days, a fixed offset that would be right in one season and
 * wrong in the other, and a shift that crosses midnight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyTimeZoneField, isCompanyTimeZone, isIanaTimeZone, localCalendarDate } from "./timezone.js";

/** The calendar date under test, read back in the form the assertions state. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ── The boundary D18 exists for ─────────────────────────────────────────────
// 2026-07-02 00:30 in Europe/London is 2026-07-01 23:30 UTC. A driver booking
// on half an hour after midnight in July has started a shift dated the 2nd;
// filing it under the UTC date would put his night's work on the previous
// day's timesheet.
test("a 00:30 Europe/London start files under the LOCAL date, not the UTC date", () => {
  const startInstant = new Date("2026-07-01T23:30:00.000Z");

  assert.equal(isoDate(startInstant), "2026-07-01", "the instant's own UTC date — the wrong answer");
  assert.equal(isoDate(localCalendarDate(startInstant, "Europe/London")), "2026-07-02");
});

// ── The company is the authority, and the mechanism is not UK-specific ──────
// ONE instant, four companies, four filing decisions. Nothing about this
// conversion is anchored to the UK — Europe/London is only V1's default.
test("one instant files under different dates for companies in different timezones", () => {
  const instant = new Date("2026-07-01T23:30:00.000Z");

  assert.equal(isoDate(localCalendarDate(instant, "Europe/London")), "2026-07-02");
  // UTC-4 in July: still the previous day, in the opposite direction to London.
  assert.equal(isoDate(localCalendarDate(instant, "America/New_York")), "2026-07-01");
  // UTC+10, southern hemisphere — its DST runs in the opposite half of the year.
  assert.equal(isoDate(localCalendarDate(instant, "Australia/Sydney")), "2026-07-02");
  // A 45-minute offset: the case that breaks any implementation assuming whole
  // hours. 23:30 UTC is 2026-07-02 05:15 in Kathmandu.
  assert.equal(isoDate(localCalendarDate(instant, "Asia/Kathmandu")), "2026-07-02");
});

// ── An offset is not a timezone ─────────────────────────────────────────────
// The same wall-clock instant of day, six months apart: Europe/London is UTC+1
// in July and UTC+0 in December, so a stored offset would file one of these
// two shifts under the wrong day.
test("the same UTC time-of-day resolves differently in summer and winter", () => {
  assert.equal(isoDate(localCalendarDate(new Date("2026-06-30T23:30:00.000Z"), "Europe/London")), "2026-07-01");
  assert.equal(isoDate(localCalendarDate(new Date("2025-12-31T23:30:00.000Z"), "Europe/London")), "2025-12-31");
});

test("a start inside a DST transition still resolves to one calendar date", () => {
  // 2026-03-29 01:00 GMT is when British Summer Time begins; 00:30 UTC is
  // half an hour before it, and 01:30 UTC is half an hour after (02:30 BST).
  assert.equal(isoDate(localCalendarDate(new Date("2026-03-29T00:30:00.000Z"), "Europe/London")), "2026-03-29");
  assert.equal(isoDate(localCalendarDate(new Date("2026-03-29T01:30:00.000Z"), "Europe/London")), "2026-03-29");
  // Autumn: 01:00→01:00 again. Both readings of the repeated hour are the 25th.
  assert.equal(isoDate(localCalendarDate(new Date("2026-10-25T00:30:00.000Z"), "Europe/London")), "2026-10-25");
  assert.equal(isoDate(localCalendarDate(new Date("2026-10-25T01:30:00.000Z"), "Europe/London")), "2026-10-25");
});

// ── Crossing midnight does not re-date the shift ────────────────────────────
// D18: one timesheet per shift, filed under the day it STARTED. The night
// driver's 22:00 → 06:00 shift is a Monday sheet, not two sheets and not a
// Tuesday one. The date is a function of the START instant alone — nothing
// else in this test's data can move it.
test("a night shift is filed under its start date, not the date it ends on", () => {
  const startInstant = new Date("2026-08-31T21:00:00.000Z"); // 22:00 local, BST
  const endInstant   = new Date("2026-09-01T05:00:00.000Z"); // 06:00 local, next day

  assert.equal(isoDate(localCalendarDate(startInstant, "Europe/London")), "2026-08-31");
  // The end instant genuinely falls on the following local day — which is why
  // deriving from the wrong instant would silently re-date the timesheet.
  assert.equal(isoDate(localCalendarDate(endInstant, "Europe/London")), "2026-09-01");
});

test("the derivation is deterministic — the same instant and zone always give the same date", () => {
  const instant = new Date("2026-08-31T21:00:00.000Z");
  const first = localCalendarDate(instant, "Europe/London");
  const second = localCalendarDate(instant, "Europe/London");
  assert.equal(first.getTime(), second.getTime());
  assert.equal(first.toISOString(), "2026-08-31T00:00:00.000Z", "a calendar date is stored at midnight UTC");
});

// ── The validation boundary ─────────────────────────────────────────────────
test("real IANA identifiers are accepted", () => {
  for (const zone of [
    "Europe/London", "Europe/Vilnius", "America/New_York", "Asia/Dubai",
    "Australia/Sydney", "Asia/Kathmandu", "Pacific/Kiritimati", "UTC",
  ]) {
    assert.equal(isIanaTimeZone(zone), true, `${zone} must be accepted`);
  }
});

test("a numeric UTC offset is REJECTED even though the runtime would resolve it", () => {
  // Intl accepts all four of these. They are not identifiers: an offset cannot
  // say which zone it is, and DST moves it twice a year.
  for (const offset of ["+01:00", "-05:00", "+0100", "−05:00"]) {
    assert.equal(isIanaTimeZone(offset), false, `${offset} must not be usable as a company timezone`);
  }
});

test("an unresolvable or malformed identifier is rejected", () => {
  for (const value of ["", " ", " Europe/London ", "Europe/Nowhere", "Not/AZone", "London", "Z"]) {
    assert.equal(isIanaTimeZone(value), false, `${JSON.stringify(value)} must be rejected`);
  }
});

// A validity check is not a safe picker. "BST" looks like British Summer Time
// to a UK reader and IS a real IANA identifier — for Bangladesh Standard Time,
// six hours away. Recorded here so that a future company-settings write path
// offers canonical identifiers to choose from rather than accepting free text
// that happens to validate.
test("a legacy abbreviation validates, but resolves to a zone nobody meant", () => {
  assert.equal(isIanaTimeZone("BST"), true);
  assert.equal(
    Intl.DateTimeFormat("en-US", { timeZone: "BST" }).resolvedOptions().timeZone,
    "Asia/Dhaka",
    "validity alone does not make an abbreviation a safe company timezone",
  );
});

test("deriving a date refuses an invalid zone or an invalid instant rather than guessing", () => {
  assert.throws(() => localCalendarDate(new Date("2026-07-01T23:30:00.000Z"), "Europe/Nowhere"), Error);
  assert.throws(() => localCalendarDate(new Date("2026-07-01T23:30:00.000Z"), "+01:00"), Error);
  assert.throws(() => localCalendarDate(new Date("not a date"), "Europe/London"), Error);
});

// ═════════════════════════════════════════════════════════════════════════════
// The zone a company CHOOSES (D53) — stricter than what the reader accepts
// ═════════════════════════════════════════════════════════════════════════════
//
// `isIanaTimeZone` decides whether a STORED zone can be read; it stays as it
// is, so every company's existing value keeps working. A NEW choice — at
// company registration — must be a PLACE (owner decision, 2026-10-03): an
// Area/Location identifier, spelled as IANA spells it, that this runtime
// resolves. Never an offset, never UTC or an Etc/ fixed-offset zone, never an
// abbreviation (BST is Asia/Dhaka). Stored exactly as chosen: Europe/Kyiv
// stays Europe/Kyiv even where the runtime calls it Europe/Kiev.

test("a company may choose any place, anywhere — not only the UK", () => {
  for (const zone of ["Europe/Vilnius", "America/New_York", "America/Chicago", "Asia/Tokyo", "Australia/Sydney",
    "America/Argentina/Buenos_Aires", "America/Port-au-Prince", "Africa/Lagos", "Europe/London"]) {
    assert.equal(isCompanyTimeZone(zone), true, zone);
  }
});

test("a zone's current AND former official names are both accepted, as chosen", () => {
  // Browsers say Europe/Kyiv and Asia/Kolkata; this runtime's list says Kiev
  // and Calcutta. Both are IANA names for the same zone.
  for (const zone of ["Europe/Kyiv", "Europe/Kiev", "Asia/Kolkata", "Asia/Calcutta"]) {
    assert.equal(isCompanyTimeZone(zone), true, zone);
    assert.equal(CompanyTimeZoneField.parse(zone), zone, `${zone} is kept exactly as chosen, not rewritten`);
  }
});

test("a fixed offset is never a company's zone — in any spelling", () => {
  for (const offset of ["+01:00", "-05:00", "+0100", "\u221205:00", "UTC+1", "GMT-5", "Etc/GMT+5", "Etc/GMT-1"]) {
    assert.equal(isCompanyTimeZone(offset), false, offset);
  }
});

test("UTC, GMT and the Etc/ zones are refused: a company is somewhere", () => {
  for (const zone of ["UTC", "GMT", "Etc/UTC", "Etc/GMT", "Universal", "Zulu"]) {
    assert.equal(isCompanyTimeZone(zone), false, zone);
  }
});

test("abbreviations are refused — BST would silently mean Asia/Dhaka", () => {
  for (const zone of ["BST", "EST", "CET", "PST8PDT"]) {
    assert.equal(isCompanyTimeZone(zone), false, zone);
  }
});

test("arbitrary or malformed strings are refused", () => {
  for (const zone of ["", " ", "Mars/Olympus", "London", "europe/london", "Europe/LONDON", "Europe/London ", " Europe/London",
    "Europe//London", "Europe/", "/London", "Europe/London/", "Europe\\London", `Europe/${"x".repeat(80)}`]) {
    assert.equal(isCompanyTimeZone(zone), false, JSON.stringify(zone));
  }
});

test("the reusable field: bounded, exact, and refuses what the predicate refuses", () => {
  assert.equal(CompanyTimeZoneField.safeParse("Asia/Tokyo").success, true);
  for (const bad of ["", "UTC", "+01:00", "Europe/London ", "x".repeat(65), 42, null]) {
    assert.equal(CompanyTimeZoneField.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

// The reason a company stores a ZONE and not an offset, for a non-UK company:
// New York is UTC-5 in January and UTC-4 in July. The same 04:30 UTC is the
// previous evening in winter and just after midnight in summer — a stored
// "-05:00" would file the July shift under the wrong day.
test("a chosen zone keeps its daylight-saving rules — the same UTC time files differently by season", () => {
  assert.equal(isCompanyTimeZone("America/New_York"), true);
  assert.equal(isoDate(localCalendarDate(new Date("2026-01-15T04:30:00.000Z"), "America/New_York")), "2026-01-14");
  assert.equal(isoDate(localCalendarDate(new Date("2026-07-15T04:30:00.000Z"), "America/New_York")), "2026-07-15");
});
