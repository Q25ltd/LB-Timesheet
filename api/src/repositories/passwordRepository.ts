/**
 * Password replacement — by recovery token, or by the signed-in account
 * (owner decision B7). The ONE place a stored password hash is rewritten.
 *
 * GLOBAL, like `identityRepository`: a password belongs to the User, never to
 * a company, and nothing here takes a `TenantContext` — so there is no path
 * by which a company role reaches another user's credential.
 *
 * Both writes are single transactions, because what they change together must
 * be true together:
 *
 *   reset   consume the token     +  replace the hash  +  revoke EVERY session
 *   change  consume any unused    +  replace the hash  +  revoke every OTHER session
 *           reset token
 *
 * A reset that replaced the hash but left a session alive would leave a
 * device the person was recovering FROM still signed in; one that revoked
 * sessions but kept the old hash would sign them out for nothing.
 */
import type { AccountTokenPurpose } from "../generated/enums.js";

interface ResetTokenRow {
  userId: string;
  purpose: AccountTokenPurpose;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface PasswordTransaction {
  accountToken: {
    updateMany(args: {
      where:
        | { tokenHash: string; userId: string; purpose: AccountTokenPurpose; consumedAt: null; expiresAt: { gt: Date } }
        | { userId: string; purpose: AccountTokenPurpose; consumedAt: null };
      data: { consumedAt: Date };
    }): Promise<{ count: number }>;
  };
  user: {
    update(args: { where: { id: string }; data: { passwordHash: string } }): Promise<{ id: string }>;
  };
  session: {
    updateMany(args: {
      where: { userId: string; revokedAt: null; id?: { not: string } };
      data: { revokedAt: Date };
    }): Promise<{ count: number }>;
  };
}

export interface PasswordDatabase {
  accountToken: {
    findUnique(args: { where: { tokenHash: string } }): Promise<ResetTokenRow | null>;
  };
  user: {
    findUnique(args: { where: { id: string } }): Promise<{ id: string; passwordHash: string } | null>;
  };
  $transaction<T>(fn: (tx: PasswordTransaction) => Promise<T>): Promise<T>;
}

export function passwordRepository(db: PasswordDatabase) {
  return {
    /**
     * The account a LIVE reset token belongs to, or null — read before any
     * password is hashed, so a junk token costs no bcrypt work (F-28). Not
     * the guarantee: `redeemReset`'s conditional write re-checks all of it.
     */
    async liveResetTokenOwner(tokenHash: string, now: Date): Promise<string | null> {
      const row = await db.accountToken.findUnique({ where: { tokenHash } });
      if (row === null || row.purpose !== "password_reset") return null;
      if (row.consumedAt !== null || row.expiresAt.getTime() <= now.getTime()) return null;
      return row.userId;
    },

    /**
     * Consume the token, replace the hash and revoke every session — or do
     * none of it. False when the token was consumed, superseded or expired
     * between the read and this write; the transaction then writes nothing.
     */
    async redeemReset(input: { tokenHash: string; userId: string; passwordHash: string; now: Date }): Promise<boolean> {
      return db.$transaction(async tx => {
        const { count } = await tx.accountToken.updateMany({
          where: {
            tokenHash:  input.tokenHash,
            userId:     input.userId,
            purpose:    "password_reset",
            consumedAt: null,
            expiresAt:  { gt: input.now },
          },
          data: { consumedAt: input.now },
        });
        if (count !== 1) return false;

        await tx.user.update({ where: { id: input.userId }, data: { passwordHash: input.passwordHash } });
        // EVERY session, phone and browser (B7): no device that was signed in
        // before a recovery stays signed in after it.
        await tx.session.updateMany({
          where: { userId: input.userId, revokedAt: null },
          data:  { revokedAt: input.now },
        });
        return true;
      });
    },

    /** The stored hash of the authenticated account, or null if it is gone. */
    async currentHash(userId: string): Promise<string | null> {
      const row = await db.user.findUnique({ where: { id: userId } });
      return row === null ? null : row.passwordHash;
    },

    /**
     * Replace the hash, spend this account's unused reset link, and revoke
     * every session EXCEPT the one making the change (B7) — in one
     * transaction, so a change that fails leaves the link usable.
     *
     * A change is a security boundary (owner decision, 2026-10-03): a reset
     * link issued before it must not change the password after it. The link
     * is spent the way a redeemed one is — `consumedAt` — so `redeemReset`
     * refuses it exactly as it refuses a used link. Scoped to THIS account.
     */
    async changePassword(input: { userId: string; keepSessionId: string; passwordHash: string; now: Date }): Promise<void> {
      await db.$transaction(async tx => {
        await tx.user.update({ where: { id: input.userId }, data: { passwordHash: input.passwordHash } });
        await tx.accountToken.updateMany({
          where: { userId: input.userId, purpose: "password_reset", consumedAt: null },
          data:  { consumedAt: input.now },
        });
        await tx.session.updateMany({
          where: { userId: input.userId, revokedAt: null, id: { not: input.keepSessionId } },
          data:  { revokedAt: input.now },
        });
      });
    },
  };
}

export type PasswordRepository = ReturnType<typeof passwordRepository>;
