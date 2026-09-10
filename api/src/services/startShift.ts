/**
 * Start Shift — the driver has begun work.
 *
 * The invariant this module exists to hold:
 *
 *   An authenticated ACTIVE driver can start exactly one open Shift for the
 *   membership their token names, using the driver's own declared start
 *   instant, with `shiftDate` derived once from that instant in the
 *   authoritative Company timezone (D18) — and that Shift is valid with ZERO
 *   asset segments.
 *
 * The zero-segment part is the product point, not an omission. A driver books
 * on at 06:00 and may not be handed a truck until 08:00; that is one shift
 * starting at 06:00, not two, and not a shift with a placeholder vehicle. No
 * vehicle type, registration, mileage or check is required to start work, and
 * none is invented here to satisfy a schema.
 *
 * The vehicle/check branch of the product's Start Shift flow attaches to this
 * later; it is deliberately absent.
 */
import { z } from "zod";
import type { AuthContext } from "../lib/auth.js";
import { authorizeTenant } from "../lib/authorization.js";
import { AppError } from "../lib/errors.js";
import { localCalendarDate } from "../lib/timezone.js";
import type { ShiftStatus } from "../generated/enums.js";
import {
  prismaErrorCode,
  UNIQUE_VIOLATION_CODE,
  type StartedShift,
  type StartShiftRepository,
} from "../repositories/startShiftRepository.js";

/**
 * Completing Start Shift means the driver IS working, so the shift is `active`
 * from the moment it is created. `draft` stays reserved for the recoverable,
 * not-yet-finished setup the vehicle/check branch will need — one meaning per
 * state, decided once here rather than per call site.
 */
const STARTED_STATUS: ShiftStatus = "active";

/** The all-zeroes UUID: syntactically a UUID, never a generated one. Refused
 *  because a client bug emitting it would pin one membership to one shift id
 *  for good — every later start would look like a mismatched replay. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Exactly two fields, and both are the driver's own data.
 *
 * `.strict()` is load-bearing rather than tidy: a client that sends
 * `companyId`, `userId`, `membershipId`, `shiftDate`, `timezone`, `driverName`
 * or `status` is REFUSED, not quietly ignored. Silently dropping an authority
 * field teaches a client that it was accepted; refusing it says plainly that
 * tenant identity and derived business facts are the server's, and are taken
 * from the verified token and the Company row (AUTH.md).
 */
export const StartShiftBody = z.object({
  /**
   * The driver's DECLARED official start of work, as an instant.
   *
   * An offset is mandatory: a bare wall-clock time would force this API to
   * guess a zone, and D18 forbids guessing. "Now" and a manually corrected
   * time produce the same field — the server never substitutes its own
   * receipt time, which offline would be the moment a queued call finally got
   * signal, hours after the driver actually started.
   *
   * The server imposes NO limit on how far back or how far forward it may
   * sit. That is a product decision, not an oversight: this is the official
   * timesheet time, and a driver who forgot to book on enters 06:00 at 08:00,
   * while a company that rounds to the quarter hour enters 15:45 at 15:40.
   * Both are correct, and neither is distinguishable server-side from a
   * mistake — so the value is accepted and stored verbatim. The app warns the
   * driver when a manually entered time is far from the device clock; a
   * warning is the mobile layer's job, and it never becomes a rejection here.
   */
  startedAt: z.iso.datetime({ offset: true }),

  /**
   * The client's stable id for THIS logical Start Shift, reused on every
   * replay of it and never on a new one. A UUID because the mobile client can
   * produce one with no dependency and no server round trip — which is the
   * whole point when there is no signal.
   */
  clientEventId: z.uuid().refine(value => value !== NIL_UUID, "clientEventId must be a generated id"),
}).strict();

export type StartShiftInput = z.infer<typeof StartShiftBody>;

/** What a client is told about a shift. Authority fields (company, user,
 *  membership) are deliberately absent — the caller established those. */
export interface ShiftView {
  id: string;
  status: ShiftStatus;
  startedAt: string;
  shiftDate: string;
}

export interface StartShiftResult {
  /** False when this was a replay of a start that already succeeded. */
  created: boolean;
  shift: ShiftView;
}

function view(shift: StartedShift): ShiftView {
  return {
    id:        shift.id,
    status:    shift.status,
    // The instant stays UTC; only the FILING DATE is company-local (D18).
    startedAt: shift.startedAt.toISOString(),
    // A calendar date carries no time of day. Emitting it as a timestamp
    // invites a client to re-zone it into the previous or next day.
    shiftDate: shift.shiftDate.toISOString().slice(0, 10),
  };
}

/**
 * The driver already has an open shift, and this is not a replay of it.
 *
 * Deliberately opaque. It carries no shift id, no date, no start time, no
 * company and no hint about WHICH company the open shift belongs to — a driver
 * may work for several (D12), and company B learning that he is on shift
 * somewhere else is exactly the disclosure CLAUDE.md's privacy boundary
 * forbids. The driver resolves it in the app that owns that shift.
 */
function shiftAlreadyOpen(): AppError {
  return new AppError(409, "You already have an open shift", "SHIFT_ALREADY_OPEN");
}

/**
 * The same client event id arrived with different start data.
 *
 * Not a retry and not a new start: one of the two is wrong, and the server
 * cannot tell which. Mutating the stored shift would let a replay silently
 * re-time a working day; creating a second one would break the identity the
 * client established. So neither happens, and the client is told. Carries no
 * detail of the stored shift, for the same reason as above.
 */
function clientEventMismatch(): AppError {
  return new AppError(409, "This start does not match the one already recorded", "CLIENT_EVENT_MISMATCH");
}

/** A replay resolves to the stored shift only if it says the same thing. */
function resolveReplay(stored: StartedShift, startedAt: Date): StartShiftResult {
  if (stored.startedAt.getTime() !== startedAt.getTime()) throw clientEventMismatch();
  return { created: false, shift: view(stored) };
}

export async function startShift(
  auth: AuthContext,
  input: StartShiftInput,
  shifts: StartShiftRepository,
): Promise<StartShiftResult> {
  // Ordinary authority: an inactive membership is refused here, generically
  // (D17). AUTH.md's narrow exceptions for a deactivated membership concern an
  // ALREADY-OPEN shift; starting a new one is named as denied.
  const ctx = authorizeTenant(auth);
  const startedAt = new Date(input.startedAt);

  // The common offline case: the phone never saw the first response and is
  // replaying. Answering from the stored row costs one read and avoids
  // provoking a constraint violation for something that is not an error.
  const replayed = await shifts.findByClientEvent(ctx, input.clientEventId);
  if (replayed !== null) return resolveReplay(replayed, startedAt);

  const context = await shifts.startContext(ctx);
  if (context === null) {
    // The token authenticated against a membership row, so its company and
    // user must exist. If they do not, something is wrong server-side —
    // refuse loudly rather than filing the shift under a guessed timezone or
    // an invented driver name.
    throw new Error("startShift: the authenticated company or user row is missing");
  }

  const shiftDate = localCalendarDate(startedAt, context.timezone);

  try {
    const created = await shifts.create(ctx, {
      clientEventId: input.clientEventId,
      startedAt,
      shiftDate,
      driverName:    context.driverName,
      status:        STARTED_STATUS,
    });
    return { created: true, shift: view(created) };
  } catch (error) {
    if (prismaErrorCode(error) !== UNIQUE_VIOLATION_CODE) throw error;

    // A unique index refused the insert, and TWO of them could have: the
    // one-open-shift partial index, and the client-event index. Which one is
    // answered by asking the database inside the trusted scope, rather than by
    // reading a constraint name out of the error — index names are an internal
    // detail, and a rename must not silently turn a conflict into a 500.
    const raced = await shifts.findByClientEvent(ctx, input.clientEventId);
    if (raced !== null) return resolveReplay(raced, startedAt);
    throw shiftAlreadyOpen();
  }
}

/**
 * The driver's own open shift, or null — restart and crash recovery.
 *
 * Scoped to the membership the token names, so it answers "what am I in the
 * middle of, HERE". An open shift in another company is correctly invisible:
 * this company is not entitled to know it exists.
 */
export async function currentShift(
  auth: AuthContext,
  shifts: StartShiftRepository,
): Promise<ShiftView | null> {
  const ctx = authorizeTenant(auth);
  const open = await shifts.findOpen(ctx);
  return open === null ? null : view(open);
}
