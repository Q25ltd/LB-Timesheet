/**
 * Start receipts (D66, stage S3): when a company's day is started — or a day
 * is made a company's — the phone queues one and sends it when it can. The
 * server keeps its OWN `receivedAt`: the only time that is evidence that the
 * day existed while the membership was active. The declared start is the
 * driver's data (D20) and is never evidence.
 */
import { z } from "zod";
import type { IdentityContext } from "../lib/auth.js";
import { AppError } from "../lib/errors.js";
import { authorizeStartReceipt, type SubmissionMembershipLookup } from "../lib/submissionAuthorization.js";
import { localCalendarDate } from "../lib/timezone.js";
import type { StartReceiptRepository } from "../repositories/startReceiptRepository.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Strict: the company, the user and the date are the server's — refused, never ignored. */
export const StartReceiptBody = z.object({
  membershipId:  z.string().min(1).max(64),
  /** The phone's id for the day — the same one its submission will carry. */
  clientEventId: z.uuid().refine(value => value !== NIL_UUID, "clientEventId must be a generated id"),
  /** The driver's declared start, with its offset (D18: no zone is guessed). */
  startedAt:     z.iso.datetime({ offset: true }),
}).strict();

export type StartReceiptInput = z.infer<typeof StartReceiptBody>;

/** New receipts one membership may record in any 24 hours; replays are never counted. */
const RECEIPTS_PER_MEMBERSHIP_PER_DAY = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StartReceiptResult {
  created: boolean;
  receipt: { receivedAt: string };
}

export async function recordStartReceipt(
  identity: IdentityContext,
  input: StartReceiptInput,
  memberships: SubmissionMembershipLookup,
  receipts: StartReceiptRepository,
  now: Date = new Date(),
): Promise<StartReceiptResult> {
  const ctx = await authorizeStartReceipt(identity, input.membershipId, memberships);
  const declaredStartedAt = new Date(input.startedAt);

  const existing = await receipts.find(ctx, input.clientEventId);
  if (existing !== null) return replay(existing, declaredStartedAt);

  if (await receipts.receivedSince(ctx, new Date(now.getTime() - DAY_MS)) >= RECEIPTS_PER_MEMBERSHIP_PER_DAY) {
    throw new AppError(429, "Too many requests, try again shortly", "RATE_LIMITED");
  }

  const timezone = await receipts.companyTimezone(ctx);
  const outcome = await receipts.create(ctx, {
    clientEventId:     input.clientEventId,
    declaredStartedAt,
    shiftDate:         localCalendarDate(declaredStartedAt, timezone),
    companyTimezone:   timezone,
  });
  if (outcome.kind === "existing") return replay(outcome.receipt, declaredStartedAt);
  return { created: true, receipt: { receivedAt: outcome.receipt.receivedAt.toISOString() } };
}

/** The same day sent again is the same receipt; the same id with another start is refused, changing nothing. */
function replay(stored: { declaredStartedAt: Date; receivedAt: Date }, declaredStartedAt: Date): StartReceiptResult {
  if (stored.declaredStartedAt.getTime() !== declaredStartedAt.getTime()) {
    throw new AppError(409, "This day was already recorded with another start", "RECEIPT_MISMATCH");
  }
  return { created: false, receipt: { receivedAt: stored.receivedAt.toISOString() } };
}
