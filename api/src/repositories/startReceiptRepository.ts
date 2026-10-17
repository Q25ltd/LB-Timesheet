/**
 * Start receipts (D66) — the only place they are read or written.
 *
 * Every method takes a `SubmissionContext` and keys on ITS membership, so a
 * receipt of another driver, or of another of this driver's memberships, is
 * not expressible here. The receipt's company and user are the membership's
 * own, and the database's composite key holds them to it.
 *
 * A receipt is written under the membership's row lock (`membershipLock.ts`,
 * security review R2 and R3): its active state, the replay and the daily cap
 * are all decided there, so no withdrawal can commit in between and no burst
 * of requests can count past the cap.
 */
import type { SubmissionContext } from "../lib/submissionContext.js";
import type { SubmissionMembershipLookup } from "../lib/submissionAuthorization.js";
import { lockOwnMembership, type RawQueryClient } from "./membershipLock.js";

export interface StoredReceipt {
  declaredStartedAt: Date;
  receivedAt: Date;
}

const RECEIPT = { declaredStartedAt: true, receivedAt: true } as const;

interface ReceiptTransaction extends RawQueryClient {
  shiftStartReceipt: {
    findUnique(args: { where: { membershipId_clientEventId: { membershipId: string; clientEventId: string } }; select: typeof RECEIPT }): Promise<StoredReceipt | null>;
    count(args: { where: { membershipId: string; receivedAt: { gt: Date } } }): Promise<number>;
    create(args: {
      data: { companyId: string; membershipId: string; userId: string; clientEventId: string; declaredStartedAt: Date; shiftDate: Date; companyTimezone: string; receivedAt: Date };
      select: typeof RECEIPT;
    }): Promise<StoredReceipt>;
  };
}

export interface StartReceiptDatabase {
  companyMembership: {
    findFirst(args: {
      where: { id: string; userId: string; role: "driver" };
      select: { companyId: true; active: true };
    }): Promise<{ companyId: string; active: boolean } | null>;
  };
  company: {
    findUnique(args: { where: { id: string }; select: { timezone: true } }): Promise<{ timezone: string } | null>;
  };
  shiftStartReceipt: {
    findUnique(args: { where: { membershipId_clientEventId: { membershipId: string; clientEventId: string } }; select: typeof RECEIPT }): Promise<StoredReceipt | null>;
  };
  $transaction<T>(fn: (tx: ReceiptTransaction) => Promise<T>): Promise<T>;
}

export type CreateReceiptOutcome =
  | { kind: "created" | "existing"; receipt: StoredReceipt }
  /** Withdrawn by the time the lock was held: no receipt. */
  | { kind: "inactive" }
  /** The membership already has `limit.max` receipts since `limit.since`. */
  | { kind: "over_limit" };

export function submissionMembershipLookup(db: Pick<StartReceiptDatabase, "companyMembership">): SubmissionMembershipLookup {
  return {
    findOwnDriverMembership(userId, membershipId) {
      return db.companyMembership.findFirst({ where: { id: membershipId, userId, role: "driver" }, select: { companyId: true, active: true } });
    },
  };
}

export function startReceiptRepository(db: StartReceiptDatabase) {
  return {
    find(ctx: SubmissionContext, clientEventId: string): Promise<StoredReceipt | null> {
      return db.shiftStartReceipt.findUnique({ where: { membershipId_clientEventId: { membershipId: ctx.membershipId, clientEventId } }, select: RECEIPT });
    },

    async companyTimezone(ctx: SubmissionContext): Promise<string> {
      const company = await db.company.findUnique({ where: { id: ctx.companyId }, select: { timezone: true } });
      if (company === null) throw new Error("an authorised membership's company is missing");
      return company.timezone;
    },

    /**
     * Keep the receipt — in one transaction under the membership's lock: still
     * active, not already kept (a replay is answered, never counted), under
     * the cap, then written.
     */
    create(
      ctx: SubmissionContext,
      receipt: { clientEventId: string; declaredStartedAt: Date; shiftDate: Date; companyTimezone: string },
      limit: { max: number; since: Date },
    ): Promise<CreateReceiptOutcome> {
      return db.$transaction(async tx => {
        const membership = await lockOwnMembership(tx, ctx);
        if (membership === null || !membership.active) return { kind: "inactive" } as const;
        const existing = await tx.shiftStartReceipt.findUnique({
          where: { membershipId_clientEventId: { membershipId: ctx.membershipId, clientEventId: receipt.clientEventId } },
          select: RECEIPT,
        });
        if (existing !== null) return { kind: "existing", receipt: existing } as const;
        const kept = await tx.shiftStartReceipt.count({ where: { membershipId: ctx.membershipId, receivedAt: { gt: limit.since } } });
        if (kept >= limit.max) return { kind: "over_limit" } as const;
        const created = await tx.shiftStartReceipt.create({
          // The server's time, taken under the lock — the clock a withdrawal is dated by (R3).
          data: { companyId: ctx.companyId, membershipId: ctx.membershipId, userId: ctx.userId, ...receipt, receivedAt: new Date() },
          select: RECEIPT,
        });
        return { kind: "created", receipt: created } as const;
      });
    },
  };
}

export type StartReceiptRepository = ReturnType<typeof startReceiptRepository>;
