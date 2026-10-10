/**
 * A company's driver invitations (D63) — the only place they are read or
 * written.
 *
 * Every method but one takes the administrator's `TenantContext` and puts its
 * `companyId` in the `where`, so no invitation of another company is ever
 * expressible here. The exception, `emailsSentToSince`, is the per-address
 * cap across companies: it answers a NUMBER, by the address's own index, and
 * is read only to decide whether to send an email — never shown, never rows.
 *
 * Nothing here looks up a LogisticBay account for the company, except
 * `isActiveDriver`: whether the address is one of the company's OWN active
 * drivers, which the company already knows.
 */
import type { DriverInvitationStatus } from "../generated/enums.js";
import { DriverInvitationStatus as STATUS } from "../generated/enums.js";
import type { TenantContext } from "../lib/tenantContext.js";
import { prismaErrorCode, UNIQUE_VIOLATION_CODE } from "./startShiftRepository.js";

export interface DriverInvitationRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  payrollRef: string | null;
  status: DriverInvitationStatus;
  createdAt: Date;
  expiresAt: Date;
}

export interface NewDriverInvitation {
  email: string;
  firstName: string;
  lastName: string;
  payrollRef: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface DriverInvitationCorrection {
  firstName?: string;
  lastName?: string;
  payrollRef?: string | null;
}

const ROW = {
  id: true, email: true, firstName: true, lastName: true, payrollRef: true,
  status: true, createdAt: true, expiresAt: true,
} as const;

type Row = typeof ROW;

interface InvitationWhere {
  id?: string;
  companyId?: string;
  email?: string;
  status?: DriverInvitationStatus;
  createdAt?: { gt: Date };
  expiresAt?: { gt: Date } | { lte: Date };
  emailSentAt?: { gt: Date };
}

export interface DriverInvitationDatabase {
  driverInvitation: {
    create(args: { data: NewDriverInvitation & { companyId: string; status: DriverInvitationStatus }; select: Row }): Promise<DriverInvitationRow>;
    findFirst(args: { where: InvitationWhere; select: Row }): Promise<DriverInvitationRow | null>;
    findMany(args: { where: InvitationWhere; select: Row; orderBy: { createdAt: "desc" }[] }): Promise<DriverInvitationRow[]>;
    updateMany(args: { where: InvitationWhere; data: DriverInvitationCorrection | { status: DriverInvitationStatus } | { emailSentAt: Date; sesMessageId: string } }): Promise<{ count: number }>;
    count(args: { where: InvitationWhere }): Promise<number>;
  };
  /** Parameterised SQL for the two reads below that span the company's other tables. */
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** The first row's `value` column, as a string — or null when there is no such row. */
function firstValue(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  const row: unknown = rows[0];
  if (typeof row !== "object" || row === null || !("value" in row)) return null;
  const { value } = row;
  return typeof value === "string" ? value : null;
}

/** The outcome of adding a driver. */
export type CreateOutcome =
  | { kind: "created"; invitation: DriverInvitationRow }
  | { kind: "exists" };

export function driverInvitationRepository(db: DriverInvitationDatabase) {
  return {
    async companyName(ctx: TenantContext): Promise<string | null> {
      return firstValue(await db.$queryRaw`SELECT "name" AS value FROM "Company" WHERE "id" = ${ctx.companyId}`);
    },

    /** Invitations this company has made since `since` — its 24-hour cap. */
    countCreatedSince(ctx: TenantContext, since: Date): Promise<number> {
      return db.driverInvitation.count({ where: { companyId: ctx.companyId, createdAt: { gt: since } } });
    },

    /** Is `email` one of THIS company's active drivers? By the account's unique key and the company's own membership. */
    async isActiveDriver(ctx: TenantContext, email: string): Promise<boolean> {
      const found = await db.$queryRaw`
        SELECT m."id" AS value
          FROM "User" u
          JOIN "CompanyMembership" m ON m."userId" = u."id"
         WHERE u."accountKind" = 'driver' AND u."email" = ${email}
           AND m."companyId" = ${ctx.companyId} AND m."active"
         LIMIT 1`;
      return firstValue(found) !== null;
    },

    /**
     * Add the invitation. A lapsed pending one for the same address is marked
     * expired first; a LIVE one means the address is already invited, and
     * the database's partial unique index decides that — also under a race.
     */
    async create(ctx: TenantContext, invitation: NewDriverInvitation): Promise<CreateOutcome> {
      await db.driverInvitation.updateMany({
        where: { companyId: ctx.companyId, email: invitation.email, status: STATUS.pending, expiresAt: { lte: invitation.createdAt } },
        data: { status: STATUS.expired },
      });
      try {
        const row = await db.driverInvitation.create({
          data: { ...invitation, companyId: ctx.companyId, status: STATUS.pending },
          select: ROW,
        });
        return { kind: "created", invitation: row };
      } catch (error) {
        if (prismaErrorCode(error) === UNIQUE_VIOLATION_CODE) return { kind: "exists" };
        throw error;
      }
    },

    list(ctx: TenantContext): Promise<DriverInvitationRow[]> {
      return db.driverInvitation.findMany({ where: { companyId: ctx.companyId }, select: ROW, orderBy: [{ createdAt: "desc" }] });
    },

    find(ctx: TenantContext, id: string): Promise<DriverInvitationRow | null> {
      return db.driverInvitation.findFirst({ where: { id, companyId: ctx.companyId }, select: ROW });
    },

    /** Correct a LIVE pending invitation; false when there is none by that id in this company. */
    async correct(ctx: TenantContext, id: string, correction: DriverInvitationCorrection, now: Date): Promise<boolean> {
      const { count } = await db.driverInvitation.updateMany({
        where: { id, companyId: ctx.companyId, status: STATUS.pending, expiresAt: { gt: now } },
        data: correction,
      });
      return count === 1;
    },

    /** Cancel a LIVE pending invitation; false when there is none by that id in this company. */
    async cancel(ctx: TenantContext, id: string, now: Date): Promise<boolean> {
      const { count } = await db.driverInvitation.updateMany({
        where: { id, companyId: ctx.companyId, status: STATUS.pending, expiresAt: { gt: now } },
        data: { status: STATUS.cancelled },
      });
      return count === 1;
    },

    /** The invitation email SES accepted — recorded on the invitation, never as an account's email (D56). */
    async recordSent(ctx: TenantContext, id: string, sesMessageId: string, at: Date): Promise<void> {
      await db.driverInvitation.updateMany({ where: { id, companyId: ctx.companyId }, data: { emailSentAt: at, sesMessageId } });
    },

    /**
     * Invitation emails sent to `email` since `since`, by ANY company — the
     * per-address cap (D63). A number, never rows, and never shown to anyone.
     */
    emailsSentToSince(email: string, since: Date): Promise<number> {
      return db.driverInvitation.count({ where: { email, emailSentAt: { gt: since } } });
    },
  };
}

export type DriverInvitationRepository = ReturnType<typeof driverInvitationRepository>;
