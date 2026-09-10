/**
 * The persistence the ACCOUNT boundary needs, and nothing else.
 *
 * Deliberately not a tenant repository, and it takes no `TenantContext`:
 * registration and `/auth/me` happen BEFORE any company is selected, and for
 * a zero-membership driver there is no company to select at all (D21). A
 * `TenantContext` parameter here would be a lie — there is no tenant to scope
 * to — and inventing one would be exactly the fake-tenant failure D21 forbids.
 *
 * The corresponding discipline is that this repository may only touch the
 * GLOBAL models (`User`, `Session`, and read-only `CompanyMembership`), never
 * a tenant-owned one. `check-rules`' `tenant-models-via-repository` enforces
 * the Shift half of that mechanically; the rest is this comment and review.
 *
 * Delegates are named individually — the `AuthStore` / `StartShiftDatabase`
 * pattern — so widening what the account boundary can reach is a visible act
 * rather than a side effect of passing a bigger object.
 */
import type { MembershipRole } from "../generated/enums.js";

/** Only the User columns anything above this boundary is allowed to see. */
export interface AccountUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

/**
 * A driver's membership as the ACCOUNT view may describe it — never as
 * authority. Present so `/auth/me` can tell the app "you have none" honestly,
 * and so the shape does not have to change when a driver joins a company.
 * Nothing derives tenant scope from this: that still requires a tenant token
 * whose membership is validated on every request.
 */
export interface AccountMembership {
  membershipId: string;
  companyId: string;
  companyName: string;
  role: MembershipRole;
}

/** Everything a new account is created from. Already normalised and hashed. */
export interface NewAccount {
  email: string;
  firstName: string;
  lastName: string;
  passwordHash: string;
  sessionExpiresAt: Date;
  refreshTokenHash: string;
}

/** The account and the device session it was created with, in one act. */
export interface CreatedAccount {
  user: AccountUser;
  sessionId: string;
}

interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface MembershipRow {
  id: string;
  companyId: string;
  role: MembershipRole;
  company: { name: string };
}

/** The subset available inside the transaction callback. */
interface IdentityTransaction {
  user: {
    create(args: { data: { email: string; firstName: string; lastName: string; passwordHash: string } }): Promise<UserRow>;
  };
  session: {
    create(args: { data: { userId: string; expiresAt: Date; refreshTokenHash: string } }): Promise<{ id: string }>;
  };
}

/**
 * The delegates this repository may use. `$transaction` is named explicitly
 * because the atomicity below is a requirement, not an optimisation.
 */
export interface IdentityDatabase extends IdentityTransaction {
  user: IdentityTransaction["user"] & {
    findUnique(args: { where: { email: string } | { id: string } }): Promise<UserRow | null>;
  };
  companyMembership: {
    findMany(args: {
      where: { userId: string; active: boolean };
      include: { company: { select: { name: true } } };
      orderBy: { joinedAt: "asc" };
    }): Promise<MembershipRow[]>;
  };
  $transaction<T>(fn: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
}

/**
 * Re-read each field onto a fresh object rather than passing the row through
 * — the `authStore` pattern. Prisma returns the whole User row, password hash
 * included; rebuilding here is what stops that hash travelling into a
 * response body, a log line or a spread somewhere upstream.
 */
function accountUser(row: UserRow): AccountUser {
  return {
    id:        row.id,
    firstName: row.firstName,
    lastName:  row.lastName,
    email:     row.email,
  };
}

/** Prisma "unique constraint failed" — the email identity already exists. */
export const UNIQUE_VIOLATION_CODE = "P2002";

export function prismaErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return null;
}

export function identityRepository(db: IdentityDatabase) {
  return {
    /**
     * Create the account and its first device session ATOMICALLY.
     *
     * The transaction is the point. A User written without a Session is a
     * half-created authenticated account: the driver holds credentials that
     * work but has no session to authenticate against, and — because the
     * email is now taken — cannot register again either. That state is
     * unrecoverable from the phone, so it must not be reachable.
     *
     * A duplicate email surfaces as P2002 from the DATABASE, not from a
     * read-then-write: `citext` uniqueness is what makes concurrent
     * registrations of the same identity resolve to one row (D22, D16).
     */
    async createAccount(account: NewAccount): Promise<CreatedAccount> {
      return db.$transaction(async tx => {
        const user = await tx.user.create({
          data: {
            email:        account.email,
            firstName:    account.firstName,
            lastName:     account.lastName,
            passwordHash: account.passwordHash,
          },
        });

        const session = await tx.session.create({
          data: {
            userId:           user.id,
            expiresAt:        account.sessionExpiresAt,
            refreshTokenHash: account.refreshTokenHash,
          },
        });

        return { user: accountUser(user), sessionId: session.id };
      });
    },

    /**
     * The account behind an already-normalised email, or null.
     *
     * Case-insensitivity comes from the column's `citext` type, so this
     * lookup finds `Driver@Example.com` when given `driver@example.com`
     * without any `mode: "insensitive"` here to forget.
     */
    async findByEmail(email: string): Promise<AccountUser | null> {
      const row = await db.user.findUnique({ where: { email } });
      return row === null ? null : accountUser(row);
    },

    /** The account behind an authenticated identity, or null if it is gone. */
    async findById(userId: string): Promise<AccountUser | null> {
      const row = await db.user.findUnique({ where: { id: userId } });
      return row === null ? null : accountUser(row);
    },

    /** The driver's ACTIVE memberships. An empty array is a valid answer (D21). */
    async listActiveMemberships(userId: string): Promise<AccountMembership[]> {
      const rows = await db.companyMembership.findMany({
        where:   { userId, active: true },
        include: { company: { select: { name: true } } },
        orderBy: { joinedAt: "asc" },
      });
      return rows.map(row => ({
        membershipId: row.id,
        companyId:    row.companyId,
        companyName:  row.company.name,
        role:         row.role,
      }));
    },
  };
}

export type IdentityRepository = ReturnType<typeof identityRepository>;
