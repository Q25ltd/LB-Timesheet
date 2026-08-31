/**
 * The ONLY database access the authentication boundary has.
 *
 * Two reads, both by primary key, both returning a narrow record built field
 * by field. Deliberately NOT a PrismaClient and not the application database
 * type: `requireAuth` must not be able to reach a tenant model, run a raw
 * query, or write anything, and it cannot express such a call through this
 * interface. The adapter below may use Prisma internally; nothing above it
 * sees Prisma at all.
 *
 * This is an adapter for one caller, not the start of a repository framework.
 * The tenant-safe repository boundary (src/repositories/, TenantContext) is a
 * different mechanism for a different problem and is untouched by this.
 */
import type { MembershipRole } from "../generated/enums.js";

/** Only the Session columns the frozen pipeline reads. */
interface AuthSession {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Only the CompanyMembership columns the frozen pipeline reads. */
interface AuthMembership {
  id: string;
  userId: string;
  companyId: string;
  role: MembershipRole;
  active: boolean;
}

export interface AuthStore {
  findSession(sessionId: string): Promise<AuthSession | null>;
  findMembership(membershipId: string): Promise<AuthMembership | null>;
}

/**
 * The two Prisma delegates the adapter is allowed to touch — named
 * individually so widening this is a visible, deliberate act rather than a
 * side effect of passing a bigger object. PrismaClient satisfies it.
 */
export interface AuthQueryable {
  session: {
    findUnique(args: { where: { id: string } }): Promise<AuthSession | null>;
  };
  companyMembership: {
    findUnique(args: { where: { id: string } }): Promise<AuthMembership | null>;
  };
}

/**
 * Re-reads each field onto a fresh object rather than passing the row through.
 * A full row arriving from Prisma (password hashes on a future join, refresh
 * token hashes on this one) stops here instead of travelling into an
 * AuthContext or a log line.
 */
export function authStore(source: AuthQueryable): AuthStore {
  return {
    async findSession(sessionId: string) {
      const row = await source.session.findUnique({ where: { id: sessionId } });
      if (row === null) return null;
      return {
        id:        row.id,
        userId:    row.userId,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      };
    },

    async findMembership(membershipId: string) {
      const row = await source.companyMembership.findUnique({ where: { id: membershipId } });
      if (row === null) return null;
      return {
        id:        row.id,
        userId:    row.userId,
        companyId: row.companyId,
        role:      row.role,
        active:    row.active,
      };
    },
  };
}
