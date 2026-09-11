/**
 * The canonical stored form of an email identity (D22).
 *
 * Lives here rather than inside one service because BOTH sides of the account
 * boundary depend on it meaning the same thing: registration decides which
 * row is written, login decides which row is found. Two copies of this
 * function are two definitions of "the same account", and the day they drift
 * a driver who registered with a capital letter can no longer sign in.
 *
 * Trimmed and lowercased, and deliberately nothing else — `+`-tags and dots
 * are NOT stripped, because those forms address genuinely different mailboxes
 * and merging them would be a worse bug than the casing one this fixes.
 *
 * This is the convenience, not the guarantee. `User.email` is `citext`, so
 * the DATABASE refuses a case variant even if some future write path forgets
 * to call this (D16).
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
