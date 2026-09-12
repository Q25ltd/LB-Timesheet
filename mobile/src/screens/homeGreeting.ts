/**
 * Home's greeting and date line. Decoration, and deliberately nothing more.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT `shiftDate`. Read this before reusing anything here.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `Shift.shiftDate` is the company's LOCAL calendar date, derived server-side
 * from the instant the driver declared and `Company.timezone` (D18). It is the
 * filing date of a legal record, it is computed once by `api/src/lib/timezone.ts`,
 * and a 00:30 start in Europe/London files under that day and not the UTC one.
 *
 * What is below is the DEVICE's own local date, shown to be friendly. The two
 * must never share code and must never share a name: one is a greeting, the
 * other decides which working day a timesheet belongs to. Home is also
 * company-neutral, so it has no `Company.timezone` to read and must not go
 * looking for one.
 *
 * Both functions are PURE — they take the instant rather than reading a clock,
 * so their boundaries are testable at fixed times on any machine in any zone.
 *
 * Formatting is explicit rather than `toLocaleDateString`. That is a choice:
 * the runtime's ICU data differs between Hermes on a phone and Node in the
 * test runner, and the displayed string would also change with the phone's
 * locale — so the format that was reviewed would not be the format that ships.
 * V1 is English; when a second language is a real requirement, this is the one
 * place it changes.
 */

export type Salutation = "Good morning" | "Good afternoon" | "Good evening";

/** Local hour at which "morning" becomes "afternoon". */
const NOON = 12;
/** Local hour at which "afternoon" becomes "evening". */
const EVENING = 18;

/**
 * The salutation for a local instant.
 *
 *   00:00 – 11:59  Good morning
 *   12:00 – 17:59  Good afternoon
 *   18:00 – 23:59  Good evening
 *
 * A 04:45 book-on is morning, which is the case this product sees most.
 */
export function salutationFor(now: Date): Salutation {
  const hour = now.getHours();
  if (hour < NOON) return "Good morning";
  if (hour < EVENING) return "Good afternoon";
  return "Good evening";
}

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * The device-local date, as "Monday, 7 September 2026".
 *
 * No leading zero on the day, because a person does not write one.
 */
export function formatHomeDate(now: Date): string {
  const weekday = WEEKDAYS[now.getDay()];
  const month = MONTHS[now.getMonth()];

  // `getDay()` is 0–6 and `getMonth()` is 0–11 for any valid Date, so neither
  // lookup can miss. The guard exists because `noUncheckedIndexedAccess`
  // cannot know that — and it refuses loudly rather than printing a blank
  // weekday, which is the same choice `startShift` makes when a row it must
  // have is absent. Callers pass `new Date()`, which is never invalid.
  if (weekday === undefined || month === undefined) {
    throw new Error("formatHomeDate: the supplied date is not a valid instant");
  }

  return `${weekday}, ${String(now.getDate())} ${month} ${String(now.getFullYear())}`;
}
