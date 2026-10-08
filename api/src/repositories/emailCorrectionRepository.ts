/**
 * Correcting an account's email address (D56) — the one write, in one
 * transaction: the new address, unverified, and every outstanding account
 * token gone, so no link already sent to the OLD address still works.
 */
import { prismaErrorCode, UNIQUE_VIOLATION_CODE } from "./identityRepository.js";

interface EmailCorrectionTransaction {
  user: {
    update(args: { where: { id: string }; data: { email: string; emailVerifiedAt: null } }): Promise<{ id: string }>;
  };
  accountToken: {
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
}

export interface EmailCorrectionDatabase {
  $transaction<T>(fn: (tx: EmailCorrectionTransaction) => Promise<T>): Promise<T>;
}

export function emailCorrectionRepository(db: EmailCorrectionDatabase) {
  return {
    /**
     * "email-in-use" when another account OF THE SAME KIND holds the address —
     * decided by the database's unique key (D51), so a race cannot share one.
     */
    async correct(userId: string, email: string): Promise<"corrected" | "email-in-use"> {
      try {
        await db.$transaction(async tx => {
          await tx.user.update({ where: { id: userId }, data: { email, emailVerifiedAt: null } });
          await tx.accountToken.deleteMany({ where: { userId } });
        });
        return "corrected";
      } catch (error) {
        if (prismaErrorCode(error) === UNIQUE_VIOLATION_CODE) return "email-in-use";
        throw error;
      }
    },
  };
}

export type EmailCorrectionRepository = ReturnType<typeof emailCorrectionRepository>;
