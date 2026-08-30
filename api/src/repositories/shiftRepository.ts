/**
 * The tenant-safe path to Shift data and its children (segments, submit jobs).
 *
 * Every selector is built HERE, from the TenantContext — callers hand over a
 * context, a resource id, and operation data; they never supply a companyId as
 * business input, and an ID-only query is not expressible through this API.
 *
 * Cross-tenant and nonexistent are indistinguishable on purpose: both come
 * back as `null` (or `false` for deletes), so the API cannot be used as an
 * existence oracle for another company's data.
 *
 * The composite database constraints (D15, first migration) remain underneath
 * as the final integrity layer — this module is the application-level boundary,
 * and the DB is what catches anything that somehow gets past it.
 */
import type { PrismaClient } from "../generated/client.js";
import type { ShiftStatus } from "../generated/enums.js";
import type { TenantContext } from "../lib/tenantContext.js";

/** Prisma "record not found" on a guarded update/delete — the miss signal. */
const NOT_FOUND_CODE = "P2025";
/** Foreign-key violation — the database refusing a cross-tenant write. */
const FK_VIOLATION_CODE = "P2003";

function prismaErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return null;
}

export interface CreateShiftData {
  driverName: string;
  shiftDate: Date;
  startedAt: Date;
}

export interface UpdateShiftData {
  endedAt?: Date;
  status?: ShiftStatus;
  notes?: string | null;
  declaredAt?: Date;
  submittedAt?: Date;
}

export interface CreateSegmentData {
  sequence: number;
  truckReg: string;
  trailerReg?: string | null;
  startedAt: Date;
  odometerStart?: number | null;
}

/**
 * One completed check item, as stored in the segment's JSON columns.
 * A `type` (not an interface) so it gets an implicit index signature and is
 * assignable to Prisma's JSON input without a cast; `note` is null rather
 * than optional for the same reason.
 */
type CheckEntry = {
  key: string;
  label: string;
  result: "pass" | "fail" | "na";
  note: string | null;
};

export interface UpdateSegmentData {
  endedAt?: Date;
  odometerEnd?: number | null;
  truckChecks?: CheckEntry[];
  trailerChecks?: CheckEntry[];
  notes?: string | null;
}

export function shiftRepository(prisma: PrismaClient) {
  return {
    /**
     * The identity on the row comes from the context, nowhere else. The
     * composite FK guarantees the membership/company/user triple is real; the
     * partial index guarantees this user has no other open shift.
     */
    async create(ctx: TenantContext, data: CreateShiftData) {
      return prisma.shift.create({
        data: {
          membershipId: ctx.membershipId,
          companyId: ctx.companyId,
          userId: ctx.userId,
          driverName: data.driverName,
          shiftDate: data.shiftDate,
          startedAt: data.startedAt,
        },
      });
    },

    /**
     * Scoped by company AND the owning membership (D15) — null for another
     * tenant's id, and equally null for a same-company colleague's shift.
     * findFirst (not findUnique) because membershipId isn't part of the
     * compound unique key; id alone is already globally unique, so this
     * still returns at most one row.
     */
    async findById(ctx: TenantContext, shiftId: string) {
      return prisma.shift.findFirst({
        where: { id: shiftId, companyId: ctx.companyId, membershipId: ctx.membershipId },
        include: { segments: { orderBy: { sequence: "asc" } } },
      });
    },

    /** The driver's own shifts within this company, newest first. */
    async listOwn(ctx: TenantContext, limit = 50) {
      return prisma.shift.findMany({
        where: { companyId: ctx.companyId, userId: ctx.userId },
        orderBy: { shiftDate: "desc" },
        take: Math.min(limit, 200),
      });
    },

    /**
     * Null when the shift is another tenant's, another same-company driver's,
     * or simply doesn't exist — all three are the identical P2025 from
     * Prisma's extended-where-unique input (the unique id_companyId selector
     * plus an additional non-unique membershipId filter).
     */
    async update(ctx: TenantContext, shiftId: string, data: UpdateShiftData) {
      try {
        return await prisma.shift.update({
          where: {
            id_companyId: { id: shiftId, companyId: ctx.companyId },
            membershipId: ctx.membershipId,
          },
          data,
        });
      } catch (error) {
        if (prismaErrorCode(error) === NOT_FOUND_CODE) return null;
        throw error;
      }
    },

    /** False when there was nothing of THIS membership's to delete. */
    async delete(ctx: TenantContext, shiftId: string) {
      try {
        await prisma.shift.delete({
          where: {
            id_companyId: { id: shiftId, companyId: ctx.companyId },
            membershipId: ctx.membershipId,
          },
        });
        return true;
      } catch (error) {
        if (prismaErrorCode(error) === NOT_FOUND_CODE) return false;
        throw error;
      }
    },

    /**
     * Guarded read first (the repository's own boundary), and even if that
     * were bypassed, the child's composite FK to (shiftId, companyId) makes a
     * cross-tenant insert impossible at the database.
     */
    async addSegment(ctx: TenantContext, shiftId: string, data: CreateSegmentData) {
      const shift = await this.findById(ctx, shiftId);
      if (shift === null) return null;
      try {
        return await prisma.shiftSegment.create({
          data: {
            shiftId,
            companyId: ctx.companyId,
            sequence: data.sequence,
            truckReg: data.truckReg,
            trailerReg: data.trailerReg ?? null,
            startedAt: data.startedAt,
            odometerStart: data.odometerStart ?? null,
          },
        });
      } catch (error) {
        if (prismaErrorCode(error) === FK_VIOLATION_CODE) return null;
        throw error;
      }
    },

    /**
     * updateMany filtered through the parent shift's membershipId: a
     * cross-tenant OR same-company-wrong-driver id matches zero rows, which
     * is exactly the same outcome as a nonexistent one.
     */
    async updateSegment(ctx: TenantContext, segmentId: string, data: UpdateSegmentData) {
      const result = await prisma.shiftSegment.updateMany({
        where: { id: segmentId, companyId: ctx.companyId, shift: { membershipId: ctx.membershipId } },
        data: {
          endedAt: data.endedAt,
          odometerEnd: data.odometerEnd,
          truckChecks: data.truckChecks,
          trailerChecks: data.trailerChecks,
          notes: data.notes,
        },
      });
      return result.count > 0;
    },

    /** One outbox entry for this company's shift — null across the boundary. */
    async enqueueSubmitJob(ctx: TenantContext, shiftId: string) {
      const shift = await this.findById(ctx, shiftId);
      if (shift === null) return null;
      try {
        return await prisma.shiftSubmitJob.create({
          data: { shiftId, companyId: ctx.companyId },
        });
      } catch (error) {
        if (prismaErrorCode(error) === FK_VIOLATION_CODE) return null;
        throw error;
      }
    },
  };
}

// The inferred return type is the repository's public face; a named alias
// gets exported when the first service needs to declare it — not before (knip).
