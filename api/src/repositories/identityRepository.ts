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

/**
 * The account AND its stored credential, for login and NOTHING else.
 *
 * A SEPARATE type from `AccountUser` on purpose. `AccountUser` is the shape
 * that leaves this boundary — it travels into responses, into `/auth/me` and
 * into the mobile client — and widening it to carry `passwordHash` would put
 * the hash one careless spread away from a response body. This record exists
 * only inside login's service call and is never returned upward: login reads
 * `passwordHash`, verifies, discards it, and passes `user` on.
 */
export interface AccountCredential {
  user: AccountUser;
  passwordHash: string;
}

/** A new device session for an already-authenticated account (AUTH.md). */
export interface NewSession {
  userId: string;
  expiresAt: Date;
  refreshTokenHash: string;
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

/**
 * The same row WITH the credential. Declared separately so the delegate that
 * returns it is a different, explicitly-named call — the account reads cannot
 * accidentally start returning a hash because one interface grew a field.
 */
interface CredentialRow extends UserRow {
  passwordHash: string;
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
    // Login's read, named separately from the two above because it returns
    // credential material. One call site, one signature, greppable.
    findFirst(args: { where: { email: string } }): Promise<CredentialRow | null>;
  };
  session: IdentityTransaction["session"];
  companyMembership: {
    findMany(args: {
      where: { userId: string; active: boolean };
      include: { company: { select: { name: true } } };
      orderBy: { joinedAt: "asc" };
    }): Promise<MembershipRow[]>;
    // Company selection's read. The id AND the authenticated user AND
    // `active` are all part of the same `where`, so there is no window in
    // which another user's membership has been fetched and is waiting to be
    // checked — see `findActiveMembership`.
    findFirst(args: {
      where: { id: string; userId: string; active: boolean };
      include: { company: { select: { name: true } } };
    }): Promise<MembershipRow | null>;
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

    /**
     * The account behind an already-normalised email, WITH its stored hash,
     * or null. Login's read, and login's only.
     *
     * `findFirst` rather than `findUnique` for one reason: `findUnique`'s
     * generated argument type is shared with the two account reads above, and
     * this call must return a strictly wider row. The lookup is still against
     * the single unique `citext` index on `User.email`, so it is a
     * primary-key-class read and case-insensitivity still comes from the
     * column type — there is no `mode: "insensitive"` here to forget.
     *
     * The hash is rebuilt onto a fresh object with the four account fields,
     * exactly like `accountUser` — so a future column added to `User` does not
     * silently start travelling into login's service.
     */
    async findCredentialByEmail(email: string): Promise<AccountCredential | null> {
      const row = await db.user.findFirst({ where: { email } });
      return row === null ? null : { user: accountUser(row), passwordHash: row.passwordHash };
    },

    /**
     * A NEW device session for an account that has just authenticated.
     *
     * Separate from `createAccount` because login is not registration: there
     * is no User to write and therefore no transaction to hold one — a single
     * insert is already atomic. Every successful login creates a new row;
     * nothing here revokes, reuses or touches another session, and nothing
     * here carries company identity, because a Session never does (AUTH.md).
     */
    async createSession(session: NewSession): Promise<{ sessionId: string }> {
      const row = await db.session.create({
        data: {
          userId:           session.userId,
          expiresAt:        session.expiresAt,
          refreshTokenHash: session.refreshTokenHash,
        },
      });
      return { sessionId: row.id };
    },

    /**
     * ONE active membership belonging to the authenticated user, or null.
     *
     * The company-selection read. Three conditions in one query — the
     * requested id, the authenticated user, and `active: true` — so a
     * membership that exists but belongs to someone else, and one that
     * belongs to the right user but has been deactivated, are BOTH answered
     * `null` and become the same generic 403. The caller cannot tell them
     * apart, and neither can a client (D17).
     *
     * `userId` is the AUTHENTICATED user. Nothing here takes it from a
     * request; the service reads it from the verified `IdentityContext`.
     */
    async findActiveMembership(userId: string, membershipId: string): Promise<AccountMembership | null> {
      const row = await db.companyMembership.findFirst({
        where:   { id: membershipId, userId, active: true },
        include: { company: { select: { name: true } } },
      });
      if (row === null) return null;
      return {
        membershipId: row.id,
        companyId:    row.companyId,
        companyName:  row.company.name,
        role:         row.role,
      };
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
