/**
 * Which day a USE screen works on, and where it goes when that day or use is
 * gone — one answer for Vehicle Use, Fuel / AdBlue, Vehicle Checks, Trailer
 * Use, Fridge Diesel and Trailer Checks.
 *
 * Without `timesheet` it is the open day, as it always was. With it, it is
 * that FINISHED day's uses, opened from its Timesheet page (D39): every use
 * ended, each found by its identity, and every write going back to the
 * finished day's own record.
 */
import { router, type Href } from "expo-router";
import { readFinishedDayOfUses, readOpenShift, type LocalShift } from "../shift/localShift";
import type { AccountScope } from "../shift/accountScope";

/** The day this use screen works on, in the signed-in account's records only (F-31). */
export function readScreenDay(scope: AccountScope, timesheet: string | undefined): Promise<LocalShift | null> {
  return timesheet === undefined ? readOpenShift(scope) : readFinishedDayOfUses(scope, timesheet);
}

/** Where a use screen goes when its day — or, with `dayFound`, its use — cannot be found. */
export function missingHref(timesheet: string | undefined, dayFound: boolean): Href {
  if (timesheet !== undefined) return "/timesheets";
  return dayFound ? "/active-shift" : "/today";
}

/** Leave a use screen whose target changed beneath it — a write that wrote nothing. */
export function leaveStale(timesheet: string | undefined): void {
  if (timesheet === undefined) router.dismissTo("/active-shift");
  else router.back();
}

/**
 * Where a use screen was opened from, when that is the Finish Review (D41):
 * finishing its work goes BACK there, never to Active Shift — which would
 * drop the driver out of the Finish flow.
 */
export const VIA_FINISH_REVIEW = "finish-review";

/**
 * Edit Timesheet's `review` param: open straight on the Review, for a
 * company's day with no valid declaration, or changed since it was declared,
 * to be declared (D42).
 */
export const REVIEW_TO_DECLARE = "declare";

/** The `via` param to carry on to the next use screen, when there is one. */
export function withVia<T extends Record<string, string>>(params: T, via: string | undefined): T | (T & { via: string }) {
  return via === VIA_FINISH_REVIEW ? { ...params, via } : params;
}

/** Back to the day after a use's work is done: the Finish Review when opened from it, else Active Shift. */
export function backToDay(via: string | undefined): void {
  if (via === VIA_FINISH_REVIEW) router.back();
  else router.dismissTo("/active-shift");
}

/** The `timesheet` param to carry on to the next use screen, when there is one. */
export function withTimesheet<T extends Record<string, string>>(params: T, timesheet: string | undefined): T | (T & { timesheet: string }) {
  return timesheet === undefined ? params : { ...params, timesheet };
}
