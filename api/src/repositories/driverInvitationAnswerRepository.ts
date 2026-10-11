/**
 * The DRIVER's side of D63's invitations — the only place they are read or
 * answered on a driver's behalf.
 *
 * Every method is keyed by the driver's own VERIFIED email address, which the
 * service reads from the account and never from the request; an invitation
 * addressed to anyone else is not expressible here, and is answered exactly
 * like one that does not exist. These reads span companies BY DESIGN — a
 * driver may be invited by several — and return nothing of any company but
 * its name.
 *
 * Accepting is ONE transaction: the membership is created (or the driver's
 * former one reactivated — `@@unique([companyId, userId])` means never a
 * second) and the invitation moved from pending to accepted, bound to it, by
 * a conditional write that only one of any number of concurrent acceptances
 * can make. The loser's transaction rolls back whole.
 */
import type { DriverInvitationStatus } from "../generated/enums.js";
import { DriverInvitationStatus as STATUS } from "../generated/enums.js";
import { prismaErrorCode, UNIQUE_VIOLATION_CODE } from "./startShiftRepository.js";

export interface OpenInvitation {
  id: string;
  companyName: string;
  firstName: string;
  lastName: string;
  expiresAt: Date;
}

export interface JoinedMembership {
  membershipId: string;
  companyId: string;
  companyName: string;
}

export type AnswerOutcome<T> =
  | { kind: "done"; value: T }
  /** Not this driver's — or no such invitation. One answer for both. */
  | { kind: "not_found" }
  /** This driver's, but cancelled, expired or already answered. */
  | { kind: "not_pending" };

interface InvitationRow {
  id: string;
  companyId: string;
  status: DriverInvitationStatus;
  expiresAt: Date;
  payrollRef: string | null;
  company: { name: string };
}

const INVITATION = {
  id: true, companyId: true, status: true, expiresAt: true, payrollRef: true, company: { select: { name: true } },
} as const;

interface AnswerWhere {
  id: string;
  email?: string;
  status: DriverInvitationStatus;
  expiresAt: { gt: Date };
}

interface AnswerTransaction {
  driverInvitation: {
    findFirst(args: { where: { id: string; email: string }; select: typeof INVITATION }): Promise<InvitationRow | null>;
    updateMany(args: {
      where: AnswerWhere;
      data: { status: DriverInvitationStatus; respondedAt: Date; membershipId?: string };
    }): Promise<{ count: number }>;
  };
  companyMembership: {
    findUnique(args: { where: { companyId_userId: { companyId: string; userId: string } }; select: { id: true } }): Promise<{ id: string } | null>;
    create(args: {
      data: { companyId: string; userId: string; accountKind: "driver"; role: "driver"; active: true; payrollRef: string | null };
      select: { id: true };
    }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: { active: true; payrollRef: string | null }; select: { id: true } }): Promise<{ id: string }>;
  };
}

export interface DriverInvitationAnswerDatabase {
  driverInvitation: {
    findMany(args: {
      where: { email: string; status: DriverInvitationStatus; expiresAt: { gt: Date } };
      select: { id: true; firstName: true; lastName: true; expiresAt: true; company: { select: { name: true } } };
      orderBy: { createdAt: "desc" }[];
    }): Promise<{ id: string; firstName: string; lastName: string; expiresAt: Date; company: { name: string } }[]>;
  };
  $transaction<T>(fn: (tx: AnswerTransaction) => Promise<T>): Promise<T>;
}

/** Thrown inside the transaction to roll it back: another answer got there first. */
class AnsweredMeanwhile extends Error {
  constructor() {
    super("the invitation was answered by a concurrent request");
    this.name = "AnsweredMeanwhile";
  }
}

export function driverInvitationAnswerRepository(db: DriverInvitationAnswerDatabase) {
  /** Why an invitation could not be answered: not this driver's, or no longer open. */
  async function whyNot(tx: AnswerTransaction, id: string, email: string): Promise<{ kind: "not_found" } | { kind: "not_pending" }> {
    return (await tx.driverInvitation.findFirst({ where: { id, email }, select: INVITATION })) === null
      ? { kind: "not_found" }
      : { kind: "not_pending" };
  }

  return {
    /** The open invitations addressed to this verified email, newest first. */
    async openFor(email: string, now: Date): Promise<OpenInvitation[]> {
      const rows = await db.driverInvitation.findMany({
        where:   { email, status: STATUS.pending, expiresAt: { gt: now } },
        select:  { id: true, firstName: true, lastName: true, expiresAt: true, company: { select: { name: true } } },
        orderBy: [{ createdAt: "desc" }],
      });
      return rows.map(row => ({ id: row.id, companyName: row.company.name, firstName: row.firstName, lastName: row.lastName, expiresAt: row.expiresAt }));
    },

    async accept(userId: string, email: string, id: string, now: Date): Promise<AnswerOutcome<JoinedMembership>> {
      try {
        return await db.$transaction(async tx => {
          const invitation = await tx.driverInvitation.findFirst({ where: { id, email }, select: INVITATION });
          if (invitation === null) return { kind: "not_found" } as const;
          if (invitation.status !== STATUS.pending || invitation.expiresAt.getTime() <= now.getTime()) return { kind: "not_pending" } as const;

          const existing = await tx.companyMembership.findUnique({
            where:  { companyId_userId: { companyId: invitation.companyId, userId } },
            select: { id: true },
          });
          // Rejoining reactivates the SAME row (D63); the company's payroll
          // reference is the one on the invitation the driver accepted.
          const membership = existing === null
            ? await tx.companyMembership.create({
              data:   { companyId: invitation.companyId, userId, accountKind: "driver", role: "driver", active: true, payrollRef: invitation.payrollRef },
              select: { id: true },
            })
            : await tx.companyMembership.update({ where: { id: existing.id }, data: { active: true, payrollRef: invitation.payrollRef }, select: { id: true } });

          const { count } = await tx.driverInvitation.updateMany({
            where: { id, status: STATUS.pending, expiresAt: { gt: now } },
            data:  { status: STATUS.accepted, respondedAt: now, membershipId: membership.id },
          });
          if (count !== 1) throw new AnsweredMeanwhile();
          return { kind: "done", value: { membershipId: membership.id, companyId: invitation.companyId, companyName: invitation.company.name } } as const;
        });
      } catch (error) {
        // A concurrent acceptance committed first: its membership insert or
        // its conditional write won, and this transaction rolled back whole.
        if (error instanceof AnsweredMeanwhile || prismaErrorCode(error) === UNIQUE_VIOLATION_CODE) return { kind: "not_pending" };
        throw error;
      }
    },

    async decline(email: string, id: string, now: Date): Promise<AnswerOutcome<null>> {
      return db.$transaction(async tx => {
        const { count } = await tx.driverInvitation.updateMany({
          where: { id, email, status: STATUS.pending, expiresAt: { gt: now } },
          data:  { status: STATUS.declined, respondedAt: now },
        });
        if (count === 1) return { kind: "done", value: null } as const;
        return whyNot(tx, id, email);
      });
    },
  };
}

export type DriverInvitationAnswerRepository = ReturnType<typeof driverInvitationAnswerRepository>;
