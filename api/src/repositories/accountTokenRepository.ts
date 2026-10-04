/**
 * One-time account tokens (B4, B7) — issue, and redeem exactly once.
 *
 * GLOBAL, like `identityRepository`: a token proves something about an
 * ACCOUNT, never about a company, and takes no `TenantContext`.
 *
 * The guarantees, and where each lives:
 *
 *   one outstanding token per user and purpose
 *       the `(userId, purpose)` unique key — issuing is an UPSERT on it, so a
 *       newer token REPLACES the older one in place and the superseded digest
 *       no longer exists to be found
 *   single use, and only before expiry
 *       redemption is ONE conditional `updateMany` — this digest, this
 *       purpose, unconsumed, unexpired — whose affected-row count is the
 *       proof; two concurrent redemptions cannot both match
 *   bounded lifetime
 *       computed by the caller AND refused by the migration's CHECK if longer
 *   no plaintext
 *       nothing here ever receives the token, only its digest
 *
 * Delegates are named individually, so widening this is a visible act.
 */
import type { AccountKind, AccountTokenPurpose, MembershipRole } from "../generated/enums.js";

interface AccountTokenRow {
  userId: string;
  purpose: AccountTokenPurpose;
}

interface ConsumeWhere {
  tokenHash: string;
  purpose: AccountTokenPurpose;
  consumedAt: null;
  expiresAt: { gt: Date };
}

/** The subset available inside the redemption transaction. */
interface AccountTokenTransaction {
  accountToken: {
    updateMany(args: { where: ConsumeWhere; data: { consumedAt: Date } }): Promise<{ count: number }>;
  };
  user: {
    updateMany(args: {
      where: { id: string; emailVerifiedAt: null };
      data: { emailVerifiedAt: Date };
    }): Promise<{ count: number }>;
  };
  pendingCompanyRegistration: {
    findUnique(args: { where: { userId_accountKind: { userId: string; accountKind: AccountKind } } }): Promise<{ id: string; companyName: string; timezone: string } | null>;
    deleteMany(args: { where: { id: string } }): Promise<{ count: number }>;
  };
  company: {
    create(args: { data: { name: string; timezone: string } }): Promise<{ id: string }>;
  };
  companyMembership: {
    create(args: {
      data: { companyId: string; userId: string; accountKind: AccountKind; role: MembershipRole; active: boolean };
    }): Promise<{ id: string }>;
  };
}

/** What a redeemed verification link did: confirmed the email, and — for a company registration — created the company. */
export interface EmailVerificationRedemption {
  companyRegistered: boolean;
}

export interface AccountTokenDatabase {
  accountToken: {
    upsert(args: {
      where: { userId_purpose: { userId: string; purpose: AccountTokenPurpose } };
      create: { userId: string; purpose: AccountTokenPurpose; tokenHash: string; issuedAt: Date; expiresAt: Date };
      update: { tokenHash: string; issuedAt: Date; expiresAt: Date; consumedAt: null };
    }): Promise<{ id: string }>;
    findUnique(args: { where: { tokenHash: string } }): Promise<AccountTokenRow | null>;
  };
  $transaction<T>(fn: (tx: AccountTokenTransaction) => Promise<T>): Promise<T>;
}

export interface NewAccountToken {
  userId: string;
  purpose: AccountTokenPurpose;
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
}

export function accountTokenRepository(db: AccountTokenDatabase) {
  return {
    /**
     * Issue a token, replacing any earlier one of the same purpose for this
     * user — consumed or not. One statement (INSERT … ON CONFLICT), so there
     * is no moment at which two are outstanding.
     */
    async issue(token: NewAccountToken): Promise<void> {
      await db.accountToken.upsert({
        where:  { userId_purpose: { userId: token.userId, purpose: token.purpose } },
        create: token,
        update: { tokenHash: token.tokenHash, issuedAt: token.issuedAt, expiresAt: token.expiresAt, consumedAt: null },
      });
    },

    /**
     * Redeem an email-verification token, in ONE transaction:
     *
     *   1. consume the token — this digest, unconsumed, unexpired; the
     *      affected-row count is the single-use proof, so of any number of
     *      simultaneous redemptions exactly one proceeds;
     *   2. stamp the account verified (only where still null, so the FIRST
     *      verification time is kept);
     *   3. if the account holds a PENDING COMPANY REGISTRATION (D51): create
     *      the Company — the pending name and the timezone the company chose
     *      (D53), never the schema default — create the INITIAL `admin`
     *      membership, and DELETE the pending row.
     *
     * All of it or none of it: a failure at any step rolls back the token,
     * the verification, the Company and the membership, and leaves the
     * pending row and a still-usable link. One initial administrator is NOT a
     * rule that a company has one administrator (O11) — nothing here forbids
     * another membership later.
     *
     * Null for an unknown digest, a digest of another purpose, a used one and
     * an expired one — the caller answers all of them identically.
     */
    async redeemEmailVerification(tokenHash: string, now: Date): Promise<EmailVerificationRedemption | null> {
      const row = await db.accountToken.findUnique({ where: { tokenHash } });
      if (row === null || row.purpose !== "email_verification") return null;

      return db.$transaction(async tx => {
        const { count } = await tx.accountToken.updateMany({
          where: { tokenHash, purpose: "email_verification", consumedAt: null, expiresAt: { gt: now } },
          data:  { consumedAt: now },
        });
        if (count !== 1) return null;
        await tx.user.updateMany({
          where: { id: row.userId, emailVerifiedAt: null },
          data:  { emailVerifiedAt: now },
        });

        // Only a COMPANY account can hold one (composite FK + CHECK), so a
        // driver account's link only ever confirms its email.
        const pending = await tx.pendingCompanyRegistration.findUnique({
          where: { userId_accountKind: { userId: row.userId, accountKind: "company" } },
        });
        if (pending === null) return { companyRegistered: false };

        const company = await tx.company.create({ data: { name: pending.companyName, timezone: pending.timezone } });
        await tx.companyMembership.create({
          data: { companyId: company.id, userId: row.userId, accountKind: "company", role: "admin", active: true },
        });
        // Exactly this row, or the whole completion is undone.
        const removed = await tx.pendingCompanyRegistration.deleteMany({ where: { id: pending.id } });
        if (removed.count !== 1) throw new Error("the pending company registration changed during its completion");
        return { companyRegistered: true };
      });
    },
  };
}

export type AccountTokenRepository = ReturnType<typeof accountTokenRepository>;
