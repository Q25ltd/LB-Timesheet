/**
 * One-time account tokens (B4, B7): the emailed secret and its stored digest.
 *
 * The same construction as the refresh secret and for the same reason: 32
 * uniformly random bytes have no guessable space, so a deterministic SHA-256
 * digest is safe to store and lets the token be FOUND by its digest. The
 * plaintext exists only in the email it was minted for.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AccountTokenPurpose } from "../generated/enums.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Owner decisions B4 and B7. A Record over the enum, so a new purpose cannot
 * exist without a decided lifetime — and the migration's CHECK constraint
 * refuses any row that outlives these, whatever computed it.
 */
export const ACCOUNT_TOKEN_LIFETIME_MS: Record<AccountTokenPurpose, number> = {
  email_verification: 24 * HOUR_MS,
  password_reset:     30 * 60 * 1000,
};

export function mintAccountToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashAccountToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
