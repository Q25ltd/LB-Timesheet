/**
 * A company's report address and the links that confirm it (D66) — the only
 * place either is read or written.
 *
 * The administrator's operations take a `TenantContext` and address their
 * own company only. Redeeming a link is the public exception: the token is
 * the credential, looked up by its hash, and it confirms exactly the address
 * it was sent to — only while that is still its company's address.
 *
 * Both writes lock the company's row first, so two requests at once cannot
 * leave two live links, and a link redeemed while the address is being
 * changed confirms nothing.
 */
import type { TenantContext } from "../lib/tenantContext.js";

export interface ReportEmailView {
  address: string | null;
  verified: boolean;
}

interface CompanyRow {
  name: string;
  reportEmail: string | null;
  reportEmailVerifiedAt: Date | null;
}

const COMPANY = { name: true, reportEmail: true, reportEmailVerifiedAt: true } as const;

interface TokenRow {
  id: string;
  companyId: string;
  email: string;
}

interface ReportEmailTransaction {
  $queryRaw(query: TemplateStringsArray, ...values: string[]): Promise<unknown>;
  company: {
    findUnique(args: { where: { id: string }; select: typeof COMPANY }): Promise<CompanyRow | null>;
    update(args: { where: { id: string }; data: { reportEmail: string; reportEmailVerifiedAt: null } }): Promise<unknown>;
    updateMany(args: { where: { id: string; reportEmail: string }; data: { reportEmailVerifiedAt: Date } }): Promise<{ count: number }>;
  };
  companyReportEmailToken: {
    updateMany(args: { where: { companyId: string; consumedAt: null; retiredAt: null } | { id: string; consumedAt: null; retiredAt: null }; data: { retiredAt: Date } | { consumedAt: Date } }): Promise<{ count: number }>;
    create(args: { data: { companyId: string; email: string; tokenHash: string; createdByUserId: string; createdAt: Date; expiresAt: Date } }): Promise<unknown>;
    findFirst(args: {
      where: { tokenHash: string; consumedAt: null; retiredAt: null; expiresAt: { gt: Date } };
      select: { id: true; companyId: true; email: true };
    }): Promise<TokenRow | null>;
  };
}

export interface ReportEmailDatabase {
  company: ReportEmailTransaction["company"];
  companyReportEmailToken: ReportEmailTransaction["companyReportEmailToken"] & {
    count(args: { where: { companyId: string; createdAt: { gt: Date } } }): Promise<number>;
  };
  $transaction<T>(fn: (tx: ReportEmailTransaction) => Promise<T>): Promise<T>;
}

export type ReportEmailRequest =
  | { kind: "already-verified" }
  | { kind: "issued"; companyName: string };

function viewOf(row: CompanyRow): ReportEmailView {
  return { address: row.reportEmail, verified: row.reportEmailVerifiedAt !== null };
}

/** Lock this company's row for the rest of the transaction. */
async function lockCompany(tx: ReportEmailTransaction, companyId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Company" WHERE "id" = ${companyId} FOR UPDATE`;
}

export function reportEmailRepository(db: ReportEmailDatabase) {
  return {
    async view(ctx: TenantContext): Promise<ReportEmailView> {
      const row = await db.company.findUnique({ where: { id: ctx.companyId }, select: COMPANY });
      if (row === null) throw new Error("an authorised company is missing");
      return viewOf(row);
    },

    /** Links this company asked for since `since` — the hourly cap. */
    requestsSince(ctx: TenantContext, since: Date): Promise<number> {
      return db.companyReportEmailToken.count({ where: { companyId: ctx.companyId, createdAt: { gt: since } } });
    },

    /**
     * Set the address — unconfirmed — and issue a link for it, retiring every
     * link still outstanding. The address already CONFIRMED changes nothing.
     */
    async request(
      ctx: TenantContext,
      link: { email: string; tokenHash: string; createdAt: Date; expiresAt: Date },
    ): Promise<ReportEmailRequest> {
      return db.$transaction(async tx => {
        await lockCompany(tx, ctx.companyId);
        const row = await tx.company.findUnique({ where: { id: ctx.companyId }, select: COMPANY });
        if (row === null) throw new Error("an authorised company is missing");
        if (row.reportEmail === link.email && row.reportEmailVerifiedAt !== null) return { kind: "already-verified" } as const;

        await tx.company.update({ where: { id: ctx.companyId }, data: { reportEmail: link.email, reportEmailVerifiedAt: null } });
        await tx.companyReportEmailToken.updateMany({ where: { companyId: ctx.companyId, consumedAt: null, retiredAt: null }, data: { retiredAt: link.createdAt } });
        await tx.companyReportEmailToken.create({
          data: { companyId: ctx.companyId, email: link.email, tokenHash: link.tokenHash, createdByUserId: ctx.userId, createdAt: link.createdAt, expiresAt: link.expiresAt },
        });
        return { kind: "issued", companyName: row.name } as const;
      });
    },

    /**
     * Confirm the address a link was sent to: once, before it expires, and
     * only while it is still its company's address. Null for every refusal —
     * one answer for all of them.
     */
    async redeem(tokenHash: string, now: Date): Promise<{ companyName: string } | null> {
      return db.$transaction(async tx => {
        const token = await tx.companyReportEmailToken.findFirst({
          where:  { tokenHash, consumedAt: null, retiredAt: null, expiresAt: { gt: now } },
          select: { id: true, companyId: true, email: true },
        });
        if (token === null) return null;
        await lockCompany(tx, token.companyId);
        const company = await tx.company.findUnique({ where: { id: token.companyId }, select: COMPANY });
        if (company === null || company.reportEmail !== token.email) return null;

        const consumed = await tx.companyReportEmailToken.updateMany({ where: { id: token.id, consumedAt: null, retiredAt: null }, data: { consumedAt: now } });
        if (consumed.count !== 1) return null;
        const confirmed = await tx.company.updateMany({ where: { id: token.companyId, reportEmail: token.email }, data: { reportEmailVerifiedAt: now } });
        if (confirmed.count !== 1) throw new Error("a locked company's report address changed during its confirmation");
        return { companyName: company.name };
      });
    },
  };
}

export type ReportEmailRepository = ReturnType<typeof reportEmailRepository>;
