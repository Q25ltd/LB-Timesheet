/**
 * A declared finish far ahead of now — confirmed, never refused (D40).
 *
 * The finish on a timesheet is DECLARED: the driver's official finish, which
 * may be later than the moment they complete it (a guaranteed day, a declared
 * booking-off time). Up to and including 15 minutes ahead of now is ordinary
 * and asks nothing. Strictly more than 15 minutes ahead is still allowed, but
 * the driver is asked once whether it is the time they mean — a guard against
 * a slipped digit, not a rule about hours worked.
 *
 * ONE rule for Finish Shift and for Edit Timesheet, and always against the
 * clock at the moment of the final press.
 */
const FINISH_AHEAD_WITHOUT_CONFIRMATION_MS = 15 * 60_000;

/** How far `endedAt` is ahead of `now` when that needs confirming; `null` when it does not. */
export function finishAheadOf(endedAt: Date, now: Date): number | null {
  const ahead = endedAt.getTime() - now.getTime();
  return ahead > FINISH_AHEAD_WITHOUT_CONFIRMATION_MS ? ahead : null;
}
