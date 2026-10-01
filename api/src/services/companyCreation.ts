/**
 * A verified identity creates a company (owner decision B3, 2026-10-01).
 *
 *   1. the person authenticates as THEMSELVES   — identity posture
 *   2. they have proved their email             — D47; read from the database
 *   3. one transaction creates the Company and THEIR `admin` membership
 *   4. tenant authority comes from the existing exchange,
 *      `POST /auth/switch-company` — nothing here mints a tenant token
 *
 * Knowledge of an email address attaches nobody to anything: the request
 * names no email, no user and no membership, and the only account this can
 * touch is the authenticated caller's.
 *
 * The refusal for an unverified account is D17's generic 403. It is the
 * caller's own state, which `/auth/me` already tells them, so nothing is
 * disclosed — but the authorization answer stays one shape.
 */
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import type { CompanyRepository } from "../repositories/companyRepository.js";
import type { AccountMembership, IdentityRepository } from "../repositories/identityRepository.js";

/** Exactly one field. A company's name is a name: CLAUDE.md's 200, trimmed. */
export const CreateCompanyBody = z.object({
  name: z.string().trim().min(1).max(200),
}).strict();

export type CreateCompanyInput = z.infer<typeof CreateCompanyBody>;

export interface CreateCompanyResult {
  membership: AccountMembership;
}

export async function createCompany(
  input: CreateCompanyInput,
  userId: string,
  accounts: IdentityRepository,
  companies: CompanyRepository,
): Promise<CreateCompanyResult> {
  const state = await accounts.findAccountState(userId);
  if (state === null) throw new AppError(401, "Not authenticated", "UNAUTHENTICATED");
  if (!state.emailVerified) throw new AppError(403, "Not allowed", "FORBIDDEN");

  const membership = await companies.createWithAdminMembership({ userId: state.user.id, name: input.name });
  return { membership };
}
