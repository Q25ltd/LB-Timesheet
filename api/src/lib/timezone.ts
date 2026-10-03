/**
 * The company IANA timezone, and the one conversion D18 depends on: an instant
 * plus a company timezone gives the local calendar date a shift is filed under.
 *
 * D18: a shift is ONE timesheet, filed under the local calendar date on which
 * it started, computed once at creation from the start instant expressed in
 * the COMPANY's timezone, and immutable afterwards. Crossing midnight does not
 * split, re-date or finish it. The phone's timezone is never the authority —
 * `Company.timezone` is.
 *
 * `Europe/London` is the V1 default in the schema because the first customers
 * are UK hauliers. It is a default, not an assumption: nothing in this module
 * knows about the UK, and every function takes the zone as an argument.
 *
 * Pure. No database, no request, no clock of its own — everything is derived
 * from the arguments, so the same instant and zone always give the same date.
 */
import { z } from "zod";

/**
 * The zone strings ECMA-402 accepts that are NOT identifiers: `+01:00`,
 * `-0500`, and the same forms written with a Unicode minus. `Intl` resolves
 * these happily, so a try/catch alone would let one be stored as a company's
 * authority — and an offset cannot express a zone, because DST moves it twice
 * a year and several zones share any given offset.
 */
const OFFSET_PREFIX = /^[+−-]/;

/**
 * True when `value` is a timezone identifier the runtime can actually resolve
 * — `Europe/London`, `Europe/Vilnius`, `America/New_York`, `Asia/Dubai`,
 * `Australia/Sydney`, and every other zone in the platform's IANA database.
 *
 * The runtime's own tz database is the authority rather than a list we
 * maintain: Node 22 ships full ICU, IANA renames and adds zones several times
 * a year, and a hand-kept list would be wrong the moment it shipped.
 * `Intl.DateTimeFormat` throws a RangeError for an identifier it cannot
 * resolve, which is the narrowest check available without a dependency.
 *
 * Legacy abbreviations are accepted, because IANA genuinely defines them:
 * `BST` resolves to Asia/Dhaka, not to British Summer Time. Validity is
 * therefore not a safe picker — a future settings write path should offer
 * canonical identifiers rather than accept free text that happens to resolve.
 *
 * There is no production write path for a company timezone yet (STATUS.md owns
 * what exists). This is the mechanism a future onboarding or settings write
 * must validate through — deliberately a predicate over an already-parsed
 * string, not a route, a DTO or a schema.
 */
export function isIanaTimeZone(value: string): boolean {
  if (OFFSET_PREFIX.test(value)) return false;
  try {
    return Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone !== "";
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * The shape of a zone a company may CHOOSE: an IANA place — Area/Location,
 * optionally Area/Region/Location — each part starting with a capital, as
 * IANA spells them (`America/Argentina/Buenos_Aires`, `America/Port-au-Prince`).
 * The migration's CHECK on `PendingCompanyRegistration.timezone` states the
 * same shape, so the database refuses what can never be one.
 */
const PLACE_SHAPE = /^[A-Z][A-Za-z]*(?:\/[A-Z][A-Za-z0-9_+-]*)+$/;
const COMPANY_TIME_ZONE_MAX = 64;

/**
 * True when `value` may be stored as the timezone a company CHOSE (D53) —
 * stricter than `isIanaTimeZone`, which decides only whether a stored zone can
 * be READ and stays as it is, so every existing company keeps working.
 *
 * A company is somewhere (owner decision, 2026-10-03), so the value must be:
 *   - a PLACE: Area/Location, never UTC, GMT or an `Etc/` zone — those are
 *     fixed offsets with a name, and an offset cannot follow a place's DST;
 *   - never an abbreviation: `BST` resolves, to Asia/Dhaka;
 *   - resolvable by THIS runtime's IANA database (`isIanaTimeZone`) — the
 *     platform is the authority, not a list kept here;
 *   - spelled as the runtime spells it wherever the runtime lists that exact
 *     zone: `Europe/LONDON` resolves, but is not the name of anything.
 *
 * A zone's current and former official names are both accepted, as chosen:
 * browsers say `Europe/Kyiv` and `Asia/Kolkata` where this runtime's list says
 * `Europe/Kiev` and `Asia/Calcutta`. Nothing is rewritten — the value stored
 * is the value chosen (owner decision, 2026-10-03).
 *
 * Limitation, stated rather than papered over: for a FORMER name that the
 * runtime does not list (`Europe/Kyiv` here), the exact casing cannot be
 * checked without a hand-kept list, so `Europe/KYIV` would pass. It still
 * resolves to the right zone; the registration picker never produces it.
 */
export function isCompanyTimeZone(value: string): boolean {
  if (value.length > COMPANY_TIME_ZONE_MAX || !PLACE_SHAPE.test(value)) return false;
  if (value.startsWith("Etc/")) return false;
  if (!isIanaTimeZone(value)) return false;
  const lower = value.toLowerCase();
  const listed = Intl.supportedValuesOf("timeZone").find(zone => zone.toLowerCase() === lower);
  return listed === undefined || listed === value;
}

/**
 * The one field a company-registration DTO uses for the company's timezone
 * (D53): bounded, NOT trimmed — a zone is chosen from a list, never typed, so
 * surrounding whitespace means the value did not come from one.
 */
export const CompanyTimeZoneField = z
  .string()
  .max(COMPANY_TIME_ZONE_MAX)
  .refine(isCompanyTimeZone, { message: "Choose a time zone from the list" });

/** A calendar date carries no time of day, so midnight UTC is its storage form. */
function utcMidnight(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/**
 * The local calendar date `instant` falls on in `timeZone`, as a Date at
 * midnight UTC — the form a Prisma `@db.Date` column stores, and the form
 * `Shift.shiftDate` will be written in when Start Shift derives it from the
 * start instant and the company's timezone.
 *
 * The instant itself stays UTC (D18): the zone decides only which local
 * business date the shift is filed under, never how the instant is stored, and
 * elapsed time is always derived from instants rather than from these dates.
 *
 * Throws rather than guessing: an unresolvable zone or an invalid instant
 * would otherwise produce a plausible-looking wrong date, and a shift filed
 * under the wrong day is invisible until payroll disputes it.
 */
export function localCalendarDate(instant: Date, timeZone: string): Date {
  if (Number.isNaN(instant.getTime())) {
    throw new Error("localCalendarDate: the instant is not a valid Date");
  }
  if (!isIanaTimeZone(timeZone)) {
    throw new Error(`localCalendarDate: ${timeZone} is not a valid IANA timezone identifier`);
  }

  // formatToParts, not a formatted string: reading named parts is independent
  // of locale ordering and of any ICU change to a locale's date pattern.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const partValue = (type: string): number =>
    Number(parts.find(part => part.type === type)?.value ?? "");
  const year = partValue("year");
  const month = partValue("month");
  const day = partValue("day");
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`localCalendarDate: could not read a calendar date in ${timeZone}`);
  }

  return utcMidnight(year, month, day);
}
