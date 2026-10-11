/**
 * A company's drivers (D65) — the only place a company reads its driver
 * memberships or changes their standing.
 *
 * Every method takes the administrator's `TenantContext` and puts its
 * `companyId` in the `where`, with `role: driver` and `removedAt: null`: a
 * membership of another company, an administrator's own membership and a
 * removed driver are all equally not expressible here, and answer the same.
 *
 * Every transition is ONE transaction: a conditional write on the state it
 * moves FROM, then the `MembershipEvent` recording it. Of any number of
 * concurrent requests only one write matches; the others change nothing and
 * record nothing. `active` stays the one access switch every request checks
 * (AUTH.md), so a transition takes effect on the driver's very next request.
 */
import type { MembershipEventKind } from "../generated/enums.js";
import { MembershipEventKind as EVENT, MembershipRole as ROLE } from "../generated/enums.js";
import type { TenantContext } from "../lib/tenantContext.js";

export interface CompanyDriverRow {
  membershipId: string;
  firstName: string;
  lastName: string;
  email: string;
  payrollRef: string | null;
  active: boolean;
  removedAt: Date | null;
  joinedAt: Date;
}

export type DriverAction = "deactivate" | "reactivate" | "remove";

export type TransitionOutcome =
  | { kind: "done"; driver: CompanyDriverRow }
  /** Not this company's driver — or removed, or no such membership. One answer for all. */
  | { kind: "not_found" }
  /** This company's driver, but not in the state the action moves from. */
  | { kind: "wrong_state" };

const DRIVER = {
  id: true, payrollRef: true, active: true, removedAt: true, joinedAt: true,
  user: { select: { firstName: true, lastName: true, email: true } },
} as const;

interface DriverRecord {
  id: string;
  payrollRef: string | null;
  active: boolean;
  removedAt: Date | null;
  joinedAt: Date;
  user: { firstName: string; lastName: string; email: string };
}

/**
 * A company's own driver membership — never another company's or an
 * administrator's. Every read and write but one also names `removedAt: null`,
 * the current drivers; the exception is reading back the row a removal just
 * wrote, by its id.
 */
interface DriverWhere {
  id?: string;
  companyId: string;
  role: typeof ROLE.driver;
  removedAt?: null;
  active?: boolean;
}

interface TransitionTransaction {
  companyMembership: {
    updateMany(args: { where: DriverWhere; data: { active: false; removedAt?: Date } | { active: true } }): Promise<{ count: number }>;
    findFirst(args: { where: DriverWhere; select: typeof DRIVER }): Promise<DriverRecord | null>;
  };
  membershipEvent: {
    create(args: { data: { companyId: string; membershipId: string; kind: MembershipEventKind; actorUserId: string; occurredAt: Date } }): Promise<unknown>;
  };
}

export interface CompanyDriverDatabase {
  companyMembership: {
    findMany(args: {
      where: DriverWhere;
      select: typeof DRIVER;
      orderBy: { joinedAt: "asc" }[];
    }): Promise<DriverRecord[]>;
  };
  $transaction<T>(fn: (tx: TransitionTransaction) => Promise<T>): Promise<T>;
}

function rowOf(record: DriverRecord): CompanyDriverRow {
  return {
    membershipId: record.id,
    firstName:    record.user.firstName,
    lastName:     record.user.lastName,
    email:        record.user.email,
    payrollRef:   record.payrollRef,
    active:       record.active,
    removedAt:    record.removedAt,
    joinedAt:     record.joinedAt,
  };
}

/** Each action: the state it moves FROM (undefined: either), what it writes, and what it records. */
function transition(action: DriverAction, now: Date): { from: boolean | undefined; data: { active: false; removedAt?: Date } | { active: true }; kind: MembershipEventKind } {
  switch (action) {
    case "deactivate": return { from: true, data: { active: false }, kind: EVENT.deactivated };
    case "reactivate": return { from: false, data: { active: true }, kind: EVENT.reactivated };
    case "remove":     return { from: undefined, data: { active: false, removedAt: now }, kind: EVENT.removed };
  }
}

export function companyDriverRepository(db: CompanyDriverDatabase) {
  const current = (ctx: TenantContext): DriverWhere => ({ companyId: ctx.companyId, role: ROLE.driver, removedAt: null });

  return {
    /** The company's drivers, active and deactivated, in the order they joined. Removed ones are not listed. */
    async list(ctx: TenantContext): Promise<CompanyDriverRow[]> {
      const records = await db.companyMembership.findMany({ where: current(ctx), select: DRIVER, orderBy: [{ joinedAt: "asc" }] });
      return records.map(rowOf);
    },

    async apply(ctx: TenantContext, membershipId: string, action: DriverAction, now: Date): Promise<TransitionOutcome> {
      const { from, data, kind } = transition(action, now);
      const target: DriverWhere = { ...current(ctx), id: membershipId };
      return db.$transaction(async tx => {
        const { count } = await tx.companyMembership.updateMany({ where: from === undefined ? target : { ...target, active: from }, data });
        if (count !== 1) {
          // Nothing changed. Say why: not this company's current driver, or not in the state this action moves from.
          return (await tx.companyMembership.findFirst({ where: target, select: DRIVER })) === null
            ? { kind: "not_found" } as const
            : { kind: "wrong_state" } as const;
        }
        await tx.membershipEvent.create({ data: { companyId: ctx.companyId, membershipId, kind, actorUserId: ctx.userId, occurredAt: now } });
        const after = await tx.companyMembership.findFirst({ where: { companyId: ctx.companyId, role: ROLE.driver, id: membershipId }, select: DRIVER });
        if (after === null) throw new Error("a membership this transaction just changed is missing");
        return { kind: "done", driver: rowOf(after) } as const;
      });
    },
  };
}

export type CompanyDriverRepository = ReturnType<typeof companyDriverRepository>;
