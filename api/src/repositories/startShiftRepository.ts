/**
 * The persistence Start Shift needs, and nothing else.
 *
 * Deliberately separate from `shiftRepository`, for two reasons rather than
 * taste. First, `shiftRepository` takes a whole `PrismaClient`, and `buildApp`
 * takes a narrow structural database on purpose — widening that to the real
 * client would make the app unbuildable without one. Second, Start Shift needs
 * two reads (`Company.timezone`, `User.name`) that a Shift repository has no
 * business owning. What is shared is the thing that matters: every selector
 * below is built HERE, from a `TenantContext`, so an id-only query is not
 * expressible through this API either.
 *
 * The queryable interfaces name each delegate method individually — the
 * `AuthStore` pattern. Widening them is then a visible act rather than a side
 * effect of passing a bigger object. `PrismaClient` satisfies them.
 */
import type { ShiftStatus } from "../generated/enums.js";
import type { TenantContext } from "../lib/tenantContext.js";

/** The Shift lifecycle states that count as OPEN (D15) — the same split the
 *  one-open-shift partial index keys on. Not exported: the only question a
 *  caller may ask is "is there an open shift", which `findOpen` answers. */
const OPEN_SHIFT_STATUSES: readonly ShiftStatus[] = ["draft", "active", "finishing"];

/** Only the columns Start Shift reads back. Prisma returns the whole row; this
 *  is what is allowed to travel out of the repository. */
export interface StartedShift {
  id: string;
  status: ShiftStatus;
  startedAt: Date;
  shiftDate: Date;
  clientEventId: string | null;
}

/** The identity a Start Shift row is created with. Every field except the
 *  driver's own data comes from the TenantContext, inside `create`. */
export interface NewShift {
  clientEventId: string;
  startedAt: Date;
  shiftDate: Date;
  driverName: string;
  status: ShiftStatus;
}

/** The trusted, server-side inputs to a Start Shift that the client may not
 *  supply: the company's filing timezone (D18) and the driver's own name. */
export interface StartContext {
  timezone: string;
  driverName: string;
}

interface ShiftWhere {
  companyId: string;
  membershipId: string;
  clientEventId?: string;
  status?: { in: ShiftStatus[] };
}

interface ShiftCreate {
  membershipId: string;
  companyId: string;
  userId: string;
  driverName: string;
  clientEventId: string;
  shiftDate: Date;
  startedAt: Date;
  status: ShiftStatus;
}

export interface StartShiftDatabase {
  shift: {
    create(args: { data: ShiftCreate }): Promise<StartedShift>;
    findFirst(args: { where: ShiftWhere }): Promise<StartedShift | null>;
  };
  company: {
    findUnique(args: { where: { id: string } }): Promise<{ timezone: string } | null>;
  };
  user: {
    findUnique(args: { where: { id: string } }): Promise<{ name: string } | null>;
  };
}

/** Prisma "unique constraint failed" — a concurrent writer got there first. */
export const UNIQUE_VIOLATION_CODE = "P2002";

export function prismaErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return null;
}

export function startShiftRepository(db: StartShiftDatabase) {
  return {
    /**
     * The company's filing timezone and the driver's name, both keyed on the
     * trusted context. Null when either row is gone — a caller must not invent
     * a timezone or a name, so there is no fallback here to reach for.
     */
    async startContext(ctx: TenantContext): Promise<StartContext | null> {
      const [company, user] = await Promise.all([
        db.company.findUnique({ where: { id: ctx.companyId } }),
        db.user.findUnique({ where: { id: ctx.userId } }),
      ]);
      if (company === null || user === null) return null;
      return { timezone: company.timezone, driverName: user.name };
    },

    /**
     * The shift a replay of this client event already created, if any.
     * Scoped to the membership as well as the company, so a replay presented
     * under company B can never resolve to a company A shift (D12).
     */
    async findByClientEvent(ctx: TenantContext, clientEventId: string): Promise<StartedShift | null> {
      return db.shift.findFirst({
        where: { companyId: ctx.companyId, membershipId: ctx.membershipId, clientEventId },
      });
    },

    /**
     * This membership's own open shift — the recovery read. Scoped by company
     * AND membership (D15), so a same-company colleague's shift is as
     * invisible as another tenant's.
     */
    async findOpen(ctx: TenantContext): Promise<StartedShift | null> {
      return db.shift.findFirst({
        where: {
          companyId:    ctx.companyId,
          membershipId: ctx.membershipId,
          // Copied per call: the exported list stays readonly, and the query
          // input Prisma declares is a mutable array.
          status:       { in: [...OPEN_SHIFT_STATUSES] },
        },
      });
    },

    /**
     * The identity on the row comes from the context, nowhere else. The
     * composite foreign key guarantees the membership/company/user triple is
     * real; the partial unique index guarantees this user has no other open
     * shift; the (membershipId, clientEventId) unique index guarantees a
     * replay cannot become a second row. All three are the DATABASE's job —
     * this method does not pre-check any of them, and lets the violation
     * surface to a caller that can tell them apart.
     */
    async create(ctx: TenantContext, data: NewShift): Promise<StartedShift> {
      return db.shift.create({
        data: {
          membershipId:  ctx.membershipId,
          companyId:     ctx.companyId,
          userId:        ctx.userId,
          driverName:    data.driverName,
          clientEventId: data.clientEventId,
          shiftDate:     data.shiftDate,
          startedAt:     data.startedAt,
          status:        data.status,
        },
      });
    },
  };
}

export type StartShiftRepository = ReturnType<typeof startShiftRepository>;
