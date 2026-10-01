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
import type { AccountTokenPurpose } from "../generated/enums.js";

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
     * Redeem an email-verification token and stamp the account verified, in
     * ONE transaction: the token is consumed if and only if the account is
     * marked. `emailVerifiedAt` is set only where it is still null, so the
     * FIRST verification time is the one kept.
     *
     * False for an unknown digest, a digest of another purpose, a used one and
     * an expired one — the caller answers all of them identically.
     */
    async redeemEmailVerification(tokenHash: string, now: Date): Promise<boolean> {
      const row = await db.accountToken.findUnique({ where: { tokenHash } });
      if (row === null || row.purpose !== "email_verification") return false;

      return db.$transaction(async tx => {
        const { count } = await tx.accountToken.updateMany({
          where: { tokenHash, purpose: "email_verification", consumedAt: null, expiresAt: { gt: now } },
          data:  { consumedAt: now },
        });
        if (count !== 1) return false;
        await tx.user.updateMany({
          where: { id: row.userId, emailVerifiedAt: null },
          data:  { emailVerifiedAt: now },
        });
        return true;
      });
    },
  };
}

export type AccountTokenRepository = ReturnType<typeof accountTokenRepository>;
