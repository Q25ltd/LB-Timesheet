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
 * REMOVED one brought back — `@@unique([companyId, userId])` means never a
 * second), the transition recorded in `MembershipEvent` (D65), and the
 * invitation moved from pending to accepted, bound to it, by a conditional
 * write that only one of any number of concurrent acceptances can make. The
 * loser's transaction rolls back whole. A DEACTIVATED membership is never
 * reactivated by an invitation (D65): only the company does that.
 */
import type { DistanceUnit, DriverInvitationStatus, MembershipEventKind, VolumeUnit } from "../generated/enums.js";
import { DriverInvitationStatus as STATUS, MembershipEventKind as EVENT } from "../generated/enums.js";
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
  distanceUnit: DistanceUnit | null;
  volumeUnit: VolumeUnit | null;
}

export type AnswerOutcome<T> =
  | { kind: "done"; value: T }
  /** Not this driver's — or no such invitation. One answer for both. */
  | { kind: "not_found" }
  /** This driver's, but cancelled, expired or already answered. */
  | { kind: "not_pending" }
  /** The company has DEACTIVATED this driver: it reactivates them, an invitation does not (D65). */
  | { kind: "inactive" };

interface InvitationRow {
  id: string;
  companyId: string;
  status: DriverInvitationStatus;
  expiresAt: Date;
  payrollRef: string | null;
  company: { name: string; distanceUnit: DistanceUnit | null; volumeUnit: VolumeUnit | null };
}

const INVITATION = {
  id: true, companyId: true, status: true, expiresAt: true, payrollRef: true,
  company: { select: { name: true, distanceUnit: true, volumeUnit: true } },
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
    findUnique(args: {
      where: { companyId_userId: { companyId: string; userId: string } };
      select: { id: true; active: true; removedAt: true };
    }): Promise<{ id: string; active: boolean; removedAt: Date | null } | null>;
    create(args: {
      data: { companyId: string; userId: string; accountKind: "driver"; role: "driver"; active: true; payrollRef: string | null };
      select: { id: true };
    }): Promise<{ id: string }>;
    updateMany(args: {
      where: { id: string; active: boolean; removedAt: { not: null } | null };
      data: { active: true; removedAt: null; payrollRef: string | null };
    }): Promise<{ count: number }>;
  };
  membershipEvent: {
    create(args: { data: { companyId: string; membershipId: string; kind: MembershipEventKind; actorUserId: string; occurredAt: Date } }): Promise<unknown>;
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
            select: { id: true, active: true, removedAt: true },
          });
          if (existing !== null && !existing.active && existing.removedAt === null) return { kind: "inactive" } as const;

          // A new driver joins; a REMOVED one comes back on the SAME row (D63,
          // D65). The company's payroll reference is the one on the
          // invitation the driver accepted. Each is a conditional write on the
          // state just read, so a concurrent company action rolls this back.
          let membershipId: string;
          let kind: MembershipEventKind | null;
          if (existing === null) {
            membershipId = (await tx.companyMembership.create({
              data:   { companyId: invitation.companyId, userId, accountKind: "driver", role: "driver", active: true, payrollRef: invitation.payrollRef },
              select: { id: true },
            })).id;
            kind = EVENT.joined;
          } else {
            const back = await tx.companyMembership.updateMany({
              where: { id: existing.id, active: existing.active, removedAt: existing.removedAt === null ? null : { not: null } },
              data:  { active: true, removedAt: null, payrollRef: invitation.payrollRef },
            });
            if (back.count !== 1) throw new AnsweredMeanwhile();
            membershipId = existing.id;
            // Already active is no transition (D63 refuses inviting one, so
            // only an invitation older than the membership gets here).
            kind = existing.active ? null : EVENT.rejoined;
          }
          if (kind !== null) {
            await tx.membershipEvent.create({ data: { companyId: invitation.companyId, membershipId, kind, actorUserId: userId, occurredAt: now } });
          }

          const { count } = await tx.driverInvitation.updateMany({
            where: { id, status: STATUS.pending, expiresAt: { gt: now } },
            data:  { status: STATUS.accepted, respondedAt: now, membershipId },
          });
          if (count !== 1) throw new AnsweredMeanwhile();
          return {
            kind: "done",
            value: {
              membershipId, companyId: invitation.companyId, companyName: invitation.company.name,
              distanceUnit: invitation.company.distanceUnit, volumeUnit: invitation.company.volumeUnit,
            },
          } as const;
        });
      } catch (error) {
        // A concurrent acceptance (or company action) committed first: its
        // insert or conditional write won, and this transaction rolled back whole.
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
