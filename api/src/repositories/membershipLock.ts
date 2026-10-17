/**
 * The ONE serialisation point for a membership's driver-side writes (security
 * review R2, R3): inside a transaction, lock the membership's own row and
 * read it again.
 *
 * - Withdrawing a driver (D65) updates that same row, so a receipt being
 *   issued and a withdrawal being committed are serialised: whichever locks
 *   first finishes first, and the other sees its result.
 * - Two writes for the same membership — receipts or submissions — queue on
 *   the lock, so a daily cap counted under it cannot be passed by requests
 *   that all counted before any of them wrote.
 *
 * Keyed on the context's membership AND user: it locks only the signed-in
 * driver's own row. Null when that row is gone.
 */
import { z } from "zod";
import type { SubmissionContext } from "../lib/submissionContext.js";

export interface RawQueryClient {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

const LockedRow = z.array(z.object({ active: z.boolean() }).strict()).max(1);

export async function lockOwnMembership(tx: RawQueryClient, ctx: SubmissionContext): Promise<{ active: boolean } | null> {
  const rows = LockedRow.parse(await tx.$queryRaw`
    SELECT "active" FROM "CompanyMembership"
    WHERE "id" = ${ctx.membershipId} AND "userId" = ${ctx.userId}
    FOR UPDATE`);
  return rows[0] ?? null;
}
