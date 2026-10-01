/**
 * Company creation (owner decision B3) — the ONE write that brings a tenant
 * into existence, together with the first membership in it.
 *
 * Not a tenant repository and takes no `TenantContext`: there is no tenant
 * until this has run. What bounds it instead is its shape — it creates a
 * Company and ONE membership, for the user id the SERVICE passes from the
 * authenticated identity, and nothing else. It cannot add a membership to an
 * existing company, and it cannot name any other user.
 *
 * Delegates are named individually, so widening this is a visible act.
 */
import type { MembershipRole } from "../generated/enums.js";
import type { AccountMembership } from "./identityRepository.js";

interface CompanyTransaction {
  company: {
    create(args: { data: { name: string } }): Promise<{ id: string; name: string }>;
  };
  companyMembership: {
    create(args: {
      data: { companyId: string; userId: string; role: MembershipRole; active: boolean };
    }): Promise<{ id: string; companyId: string; role: MembershipRole }>;
  };
}

export interface CompanyDatabase {
  $transaction<T>(fn: (tx: CompanyTransaction) => Promise<T>): Promise<T>;
}

export function companyRepository(db: CompanyDatabase) {
  return {
    /**
     * Create a Company and the creator's `admin` membership ATOMICALLY: both
     * rows or neither. A Company without its creator's membership would be a
     * tenant no one can ever reach — and, with no invitation flow, could
     * never be repaired from the product.
     *
     * `admin` is the existing role VALUE (D19); it confers nothing beyond
     * what any active membership has until company authorization is designed
     * (O11).
     */
    async createWithAdminMembership(input: { userId: string; name: string }): Promise<AccountMembership> {
      return db.$transaction(async tx => {
        const company = await tx.company.create({ data: { name: input.name } });
        const membership = await tx.companyMembership.create({
          data: { companyId: company.id, userId: input.userId, role: "admin", active: true },
        });
        return {
          membershipId: membership.id,
          companyId:    membership.companyId,
          companyName:  company.name,
          role:         membership.role,
        };
      });
    },
  };
}

export type CompanyRepository = ReturnType<typeof companyRepository>;
