/**
 * Submitted timesheets, on the DRIVER's side (D66) — the only place a
 * submission is written.
 *
 * Every method takes a `SubmissionContext` and keys on ITS membership: a
 * timesheet of another driver, or of another of this driver's memberships,
 * is not expressible here. The company is the membership's own; the
 * database's composite keys hold every row to it.
 *
 * Revision 1 is written in ONE transaction (F-16): the header, the immutable
 * snapshot, the audit events and — when it is accepted — its delivery job.
 * Either all of it exists or none of it does. It is written under the
 * membership's row lock (`membershipLock.ts`, security review R2): the replay
 * and the daily cap are decided there, so a burst of new days cannot all
 * count before any of them is written, and a replay is never counted.
 */
import { randomBytes } from "node:crypto";
import type {
  MembershipEventKind,
  TimesheetDeliveryStatus,
  TimesheetEventKind,
  TimesheetStanding,
  TimesheetVerification,
} from "../generated/enums.js";
import type { SubmissionContext } from "../lib/submissionContext.js";
import { lockOwnMembership, type RawQueryClient } from "./membershipLock.js";
import { prismaErrorCode, UNIQUE_VIOLATION_CODE } from "./startShiftRepository.js";

/** What the driver is told about a submitted timesheet. */
export interface SubmittedTimesheet {
  reference: string;
  revision: number;
  standing: TimesheetStanding;
  verification: TimesheetVerification;
  receivedAt: Date;
}

/** An earlier submission of the same day, by its revision 1. */
export interface ExistingSubmission {
  timesheet: SubmittedTimesheet | null;
  payloadSha256: string | null;
}

export interface SubmissionFacts {
  driverName: string;
  payrollRef: string | null;
  companyName: string;
  companyTimezone: string;
  /** Whether the company has a CONFIRMED report address (D66). */
  reportAddressConfirmed: boolean;
}

export type RevisionOneOutcome =
  | { kind: "created"; timesheet: SubmittedTimesheet }
  | { kind: "existing" }
  | { kind: "over_limit" };

export interface NewRevisionOne {
  clientEventId: string;
  shiftDate: Date;
  startedAt: Date;
  endedAt: Date;
  nightOut: boolean;
  notes: string | null;
  declaredAt: Date;
  declaredVersion: string;
  schemaVersion: number;
  payload: object;
  payloadSha256: string;
  verification: TimesheetVerification;
  receiptId: string | null;
  standing: TimesheetStanding;
  facts: SubmissionFacts;
  now: Date;
}

const SUBMITTED = {
  reference: true, currentRevision: true, standing: true, verification: true,
  submissions: { where: { revision: 1 }, select: { payloadSha256: true, receivedAt: true } },
} as const;

interface ExistingRow {
  reference: string | null;
  currentRevision: number | null;
  standing: TimesheetStanding | null;
  verification: TimesheetVerification | null;
  submissions: { payloadSha256: string; receivedAt: Date }[];
}

interface ShiftHeaderData {
  membershipId: string;
  companyId: string;
  userId: string;
  driverName: string;
  clientEventId: string;
  shiftDate: Date;
  startedAt: Date;
  endedAt: Date;
  status: "submitted";
  submittedAt: Date;
  declaredAt: Date;
  notes: string | null;
  reference: string;
  currentRevision: number;
  authoritativeRevision: number | null;
  verification: TimesheetVerification;
  standing: TimesheetStanding;
  receiptId: string | null;
  nightOut: boolean;
  payrollRef: string | null;
  companyName: string;
}

interface SubmissionData {
  companyId: string;
  shiftId: string;
  revision: number;
  schemaVersion: number;
  payload: object;
  payloadSha256: string;
  declaredVersion: string;
  declaredAt: Date;
  declaredBy: string;
  receivedAt: Date;
  verification: TimesheetVerification;
  filedInTimezone: string;
}

interface EventData {
  companyId: string;
  shiftId: string;
  revision: number | null;
  kind: TimesheetEventKind;
  actorUserId: string | null;
  occurredAt: Date;
}

interface DeliveryData {
  companyId: string;
  shiftId: string;
  revision: number;
  status: TimesheetDeliveryStatus;
  nextAttemptAt: Date;
}

interface SubmissionTransaction extends RawQueryClient {
  shift: {
    findFirst(args: { where: { membershipId: string; clientEventId: string }; select: { id: true } }): Promise<{ id: string } | null>;
    count(args: { where: { membershipId: string; reference: { not: null }; submittedAt: { gt: Date } } }): Promise<number>;
    create(args: { data: ShiftHeaderData; select: { id: true } }): Promise<{ id: string }>;
  };
  timesheetSubmission: {
    create(args: { data: SubmissionData; select: { receivedAt: true } }): Promise<{ receivedAt: Date }>;
  };
  timesheetEvent: {
    createMany(args: { data: EventData[] }): Promise<{ count: number }>;
  };
  timesheetDelivery: {
    create(args: { data: DeliveryData }): Promise<unknown>;
  };
}

export interface TimesheetSubmissionDatabase {
  shift: {
    findFirst(args: { where: { membershipId: string; clientEventId: string }; select: typeof SUBMITTED }): Promise<ExistingRow | null>;
  };
  shiftStartReceipt: {
    findUnique(args: { where: { membershipId_clientEventId: { membershipId: string; clientEventId: string } }; select: { id: true; receivedAt: true } }): Promise<{ id: string; receivedAt: Date } | null>;
  };
  membershipEvent: {
    findFirst(args: {
      where: { membershipId: string; kind: { in: MembershipEventKind[] } };
      orderBy: { occurredAt: "desc" };
      select: { occurredAt: true };
    }): Promise<{ occurredAt: Date } | null>;
  };
  companyMembership: {
    findFirst(args: {
      where: { id: string; userId: string };
      select: {
        payrollRef: true;
        company: { select: { name: true; timezone: true; reportEmailVerifiedAt: true } };
        user: { select: { firstName: true; lastName: true } };
      };
    }): Promise<{
      payrollRef: string | null;
      company: { name: string; timezone: string; reportEmailVerifiedAt: Date | null };
      user: { firstName: string; lastName: string };
    } | null>;
  };
  $transaction<T>(fn: (tx: SubmissionTransaction) => Promise<T>): Promise<T>;
}

/** The membership events that withdraw a driver (D65). */
const WITHDRAWALS: MembershipEventKind[] = ["deactivated", "removed"];

/** Crockford base32 without I, L, O, U: a reference read aloud is not misheard. */
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newReference(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += REFERENCE_ALPHABET[byte % 32];
  return `TS-${code}`;
}

function uniqueViolationOn(error: unknown, field: string): boolean {
  if (prismaErrorCode(error) !== UNIQUE_VIOLATION_CODE || typeof error !== "object" || error === null) return false;
  const meta: unknown = Reflect.get(error, "meta");
  const target: unknown = typeof meta === "object" && meta !== null ? Reflect.get(meta, "target") : undefined;
  return JSON.stringify(target ?? "").includes(field);
}

export function timesheetSubmissionRepository(db: TimesheetSubmissionDatabase) {
  return {
    /** This membership's earlier submission of the same day, if any. */
    async existing(ctx: SubmissionContext, clientEventId: string): Promise<ExistingSubmission | null> {
      const row = await db.shift.findFirst({ where: { membershipId: ctx.membershipId, clientEventId }, select: SUBMITTED });
      if (row === null) return null;
      const first = row.submissions[0];
      if (row.reference === null || row.currentRevision === null || row.standing === null || row.verification === null || first === undefined) {
        // A server-first shift (D19's old route) under the same id: not a submission.
        return { timesheet: null, payloadSha256: null };
      }
      return {
        payloadSha256: first.payloadSha256,
        timesheet: { reference: row.reference, revision: row.currentRevision, standing: row.standing, verification: row.verification, receivedAt: first.receivedAt },
      };
    },

    /** The start receipt this membership has for the day, if any. */
    receipt(ctx: SubmissionContext, clientEventId: string): Promise<{ id: string; receivedAt: Date } | null> {
      return db.shiftStartReceipt.findUnique({ where: { membershipId_clientEventId: { membershipId: ctx.membershipId, clientEventId } }, select: { id: true, receivedAt: true } });
    },

    /** When this membership was last deactivated or removed — server time (D65's events). */
    async latestWithdrawal(ctx: SubmissionContext): Promise<Date | null> {
      const event = await db.membershipEvent.findFirst({
        where:   { membershipId: ctx.membershipId, kind: { in: WITHDRAWALS } },
        orderBy: { occurredAt: "desc" },
        select:  { occurredAt: true },
      });
      return event?.occurredAt ?? null;
    },

    /** What the server derives — never accepts — for the header and the PDF. */
    async facts(ctx: SubmissionContext): Promise<SubmissionFacts> {
      const row = await db.companyMembership.findFirst({
        where:  { id: ctx.membershipId, userId: ctx.userId },
        select: {
          payrollRef: true,
          company: { select: { name: true, timezone: true, reportEmailVerifiedAt: true } },
          user: { select: { firstName: true, lastName: true } },
        },
      });
      if (row === null) throw new Error("an authorised membership is missing");
      return {
        driverName:             `${row.user.firstName} ${row.user.lastName}`,
        payrollRef:             row.payrollRef,
        companyName:            row.company.name,
        companyTimezone:        row.company.timezone,
        reportAddressConfirmed: row.company.reportEmailVerifiedAt !== null,
      };
    },

    /**
     * Write revision 1 — all of it, or none of it — under the membership's
     * lock: `existing` when this day is already there (the caller reads it
     * back as a replay, never counted); `over_limit` when the membership
     * already has `limit.max` submissions since `limit.since`.
     */
    async createRevisionOne(ctx: SubmissionContext, input: NewRevisionOne, limit: { max: number; since: Date }): Promise<RevisionOneOutcome> {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const reference = newReference();
        try {
          return await db.$transaction(async tx => {
            if (await lockOwnMembership(tx, ctx) === null) throw new Error("an authorised membership is missing");
            const day = await tx.shift.findFirst({ where: { membershipId: ctx.membershipId, clientEventId: input.clientEventId }, select: { id: true } });
            if (day !== null) return { kind: "existing" } as const;
            const submitted = await tx.shift.count({ where: { membershipId: ctx.membershipId, reference: { not: null }, submittedAt: { gt: limit.since } } });
            if (submitted >= limit.max) return { kind: "over_limit" } as const;
            return { kind: "created", timesheet: await writeRevisionOne(tx, ctx, input, reference) } as const;
          });
        } catch (error) {
          if (uniqueViolationOn(error, "reference")) continue;
          // Not expected under the lock; a concurrent copy that slipped past it is still a replay.
          if (prismaErrorCode(error) === UNIQUE_VIOLATION_CODE) return { kind: "existing" };
          throw error;
        }
      }
      throw new Error("could not allocate a unique timesheet reference");
    },
  };
}

async function writeRevisionOne(tx: SubmissionTransaction, ctx: SubmissionContext, input: NewRevisionOne, reference: string): Promise<SubmittedTimesheet> {
  const accepted = input.standing === "accepted";
  const shift = await tx.shift.create({
    data: {
      membershipId:          ctx.membershipId,
      companyId:             ctx.companyId,
      userId:                ctx.userId,
      driverName:            input.facts.driverName,
      clientEventId:         input.clientEventId,
      shiftDate:             input.shiftDate,
      startedAt:             input.startedAt,
      endedAt:               input.endedAt,
      status:                "submitted",
      submittedAt:           input.now,
      declaredAt:            input.declaredAt,
      notes:                 input.notes,
      reference,
      currentRevision:       1,
      authoritativeRevision: accepted ? 1 : null,
      verification:          input.verification,
      standing:              input.standing,
      receiptId:             input.receiptId,
      nightOut:              input.nightOut,
      payrollRef:            input.facts.payrollRef,
      companyName:           input.facts.companyName,
    },
    select: { id: true },
  });
  const stored = await tx.timesheetSubmission.create({
    data: {
      companyId:       ctx.companyId,
      shiftId:         shift.id,
      revision:        1,
      schemaVersion:   input.schemaVersion,
      payload:         input.payload,
      payloadSha256:   input.payloadSha256,
      declaredVersion: input.declaredVersion,
      declaredAt:      input.declaredAt,
      declaredBy:      ctx.userId,
      receivedAt:      input.now,
      verification:    input.verification,
      filedInTimezone: input.facts.companyTimezone,
    },
    select: { receivedAt: true },
  });

  const events: { kind: TimesheetEventKind; actorUserId: string | null }[] = [
    { kind: "submitted", actorUserId: ctx.userId },
    { kind: accepted ? "accepted_automatically" : "review_requested", actorUserId: null },
  ];
  if (accepted) {
    // The report email for the authoritative revision — queued with it (F-16).
    const status: TimesheetDeliveryStatus = input.facts.reportAddressConfirmed ? "queued" : "waiting_for_address";
    await tx.timesheetDelivery.create({ data: { companyId: ctx.companyId, shiftId: shift.id, revision: 1, status, nextAttemptAt: input.now } });
    events.push({ kind: "delivery_queued", actorUserId: null });
  }
  await tx.timesheetEvent.createMany({
    data: events.map(event => ({ companyId: ctx.companyId, shiftId: shift.id, revision: 1, kind: event.kind, actorUserId: event.actorUserId, occurredAt: input.now })),
  });

  return { reference, revision: 1, standing: input.standing, verification: input.verification, receivedAt: stored.receivedAt };
}

export type TimesheetSubmissionRepository = ReturnType<typeof timesheetSubmissionRepository>;
