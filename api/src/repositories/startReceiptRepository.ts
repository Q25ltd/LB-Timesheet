/**
 * Start receipts (D66) — the only place they are read or written.
 *
 * Every method takes a `SubmissionContext` and keys on ITS membership, so a
 * receipt of another driver, or of another of this driver's memberships, is
 * not expressible here. The receipt's company and user are the membership's
 * own, and the database's composite key holds them to it.
 */
import type { SubmissionContext } from "../lib/submissionContext.js";
import type { SubmissionMembershipLookup } from "../lib/submissionAuthorization.js";
import { prismaErrorCode, UNIQUE_VIOLATION_CODE } from "./startShiftRepository.js";

export interface StoredReceipt {
  declaredStartedAt: Date;
  receivedAt: Date;
}

const RECEIPT = { declaredStartedAt: true, receivedAt: true } as const;

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
    count(args: { where: { membershipId: string; receivedAt: { gt: Date } } }): Promise<number>;
    create(args: {
      data: { companyId: string; membershipId: string; userId: string; clientEventId: string; declaredStartedAt: Date; shiftDate: Date; companyTimezone: string };
      select: typeof RECEIPT;
    }): Promise<StoredReceipt>;
  };
}

export type CreateReceiptOutcome = { kind: "created" | "existing"; receipt: StoredReceipt };

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

    receivedSince(ctx: SubmissionContext, since: Date): Promise<number> {
      return db.shiftStartReceipt.count({ where: { membershipId: ctx.membershipId, receivedAt: { gt: since } } });
    },

    async companyTimezone(ctx: SubmissionContext): Promise<string> {
      const company = await db.company.findUnique({ where: { id: ctx.companyId }, select: { timezone: true } });
      if (company === null) throw new Error("an authorised membership's company is missing");
      return company.timezone;
    },

    /** Keep the receipt — or, when a concurrent copy of it got there first, answer that one. */
    async create(
      ctx: SubmissionContext,
      receipt: { clientEventId: string; declaredStartedAt: Date; shiftDate: Date; companyTimezone: string },
    ): Promise<CreateReceiptOutcome> {
      try {
        const created = await db.shiftStartReceipt.create({
          data: { companyId: ctx.companyId, membershipId: ctx.membershipId, userId: ctx.userId, ...receipt },
          select: RECEIPT,
        });
        return { kind: "created", receipt: created };
      } catch (error) {
        if (prismaErrorCode(error) !== UNIQUE_VIOLATION_CODE) throw error;
        const existing = await db.shiftStartReceipt.findUnique({
          where: { membershipId_clientEventId: { membershipId: ctx.membershipId, clientEventId: receipt.clientEventId } },
          select: RECEIPT,
        });
        if (existing === null) throw error;
        return { kind: "existing", receipt: existing };
      }
    },
  };
}

export type StartReceiptRepository = ReturnType<typeof startReceiptRepository>;
