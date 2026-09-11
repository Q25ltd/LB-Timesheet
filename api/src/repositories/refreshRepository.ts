/**
 * The refresh-token boundary — and the place F-21 is closed.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * F-21, AND WHY THIS FILE IS SHAPED LIKE THIS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The Session row holds two independently-unique digests: `refreshTokenHash`
 * (current) and `previousRefreshTokenHash` (superseded, usable inside a grace
 * window). PostgreSQL enforces uniqueness WITHIN each column and, by CHECK,
 * that the two differ WITHIN a row — but nothing prevents one Session's
 * current digest equalling another Session's previous digest. A lookup
 * written as
 *
 *     findFirst({ where: { OR: [{ refreshTokenHash: d },
 *                              { previousRefreshTokenHash: d }] } })
 *
 * can therefore match TWO rows and return whichever the planner reaches
 * first — an undefined choice of Session. That is F-21.
 *
 * The fix (owner-approved direction) is lookup discipline, not schema churn,
 * and it is enforced STRUCTURALLY rather than by comment:
 *
 *   1. `RefreshDatabase` below declares `session.findUnique` and
 *      `session.updateMany` and NOTHING ELSE. There is no `findFirst`, no
 *      `findMany`, no `$queryRaw`. An OR lookup is not merely discouraged
 *      here — it does not typecheck.
 *   2. `findUnique` is declared to accept ONLY the two single-digest keys,
 *      each of which is backed by its own unique index, so every read is a
 *      unique read by construction.
 *   3. `resolve()` owns the PRECEDENCE — current first, previous only if the
 *      current lookup found nothing — so no caller can get the order wrong,
 *      and no caller is handed a "search both" primitive to misuse.
 *
 * Everything else in this module exists because rotation must be correct
 * under concurrency: every write is a CONDITIONAL `updateMany` whose `where`
 * restates the state the caller believed it was acting on, and whose affected
 * row count is the caller's proof it won. There is no read-then-write
 * anywhere in this file.
 */
import type { ShiftStatus } from "../generated/enums.js";
import { OPEN_SHIFT_STATUSES } from "../lib/shiftStatus.js";
import { prismaErrorCode, UNIQUE_VIOLATION_CODE } from "./identityRepository.js";

/**
 * A conditional write that could not be applied because a unique index was
 * already occupied, reported as "the rotation did not happen".
 *
 * Found by the F-21 adversarial test, and worth stating plainly. Rotation
 * writes the presented digest into `previousRefreshTokenHash`, which carries
 * its own unique index — so if some OTHER Session already held that exact
 * digest in its previous slot, the write raises P2002. Reaching that state
 * needs a 256-bit collision between two CSPRNG secrets, so it is not a
 * production path; what matters is the ANSWER when it happens. An escaping
 * P2002 becomes a 500, and a 500 where every other refresh failure is a 401
 * is an oracle for "something structural is wrong with your session".
 *
 * Collapsing it to `false` makes the caller answer with the canonical 401
 * like every other refusal. Fail closed, and say nothing.
 */
async function appliedOrNot(write: Promise<{ count: number }>): Promise<boolean> {
  try {
    const { count } = await write;
    return count === 1;
  } catch (error) {
    if (prismaErrorCode(error) === UNIQUE_VIOLATION_CODE) return false;
    throw error;
  }
}

/** Which digest column matched — the caller's branch, decided here. */
type RefreshMatch = "current" | "previous";

/**
 * The Session columns the refresh boundary may see. Deliberately NOT the
 * digests: a resolved Session is identified by `id`, and nothing above this
 * boundary has a reason to hold a credential digest — the rotation methods
 * take the digest they are conditioning on as an argument instead.
 */
export interface RefreshSession {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  previousRefreshTokenGraceUntil: Date | null;
}

/** A resolved credential: which Session, and which column it matched. */
export interface ResolvedRefresh {
  session: RefreshSession;
  matched: RefreshMatch;
}

interface SessionRow {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  previousRefreshTokenGraceUntil: Date | null;
}

/**
 * The delegates this repository may use — the narrowest surface that can
 * express the refresh contract, and no wider.
 *
 * `findUnique`'s `where` is a UNION of the two single-digest keys. Prisma's
 * own generated type would also accept `id`, composite keys and (through
 * `findFirst`) arbitrary filters; restating it this narrowly is what makes
 * the ambiguous lookup unrepresentable rather than just unwritten.
 */
export interface RefreshDatabase {
  session: {
    findUnique(args: {
      where: { refreshTokenHash: string } | { previousRefreshTokenHash: string };
    }): Promise<SessionRow | null>;
    updateMany(args: {
      where: {
        id: string;
        revokedAt?: null;
        expiresAt?: { gt: Date };
        refreshTokenHash?: string;
        previousRefreshTokenHash?: string;
        previousRefreshTokenGraceUntil?: { gt: Date };
      };
      data: {
        refreshTokenHash?: string;
        previousRefreshTokenHash?: string;
        previousRefreshTokenGraceUntil?: Date;
        revokedAt?: Date;
      };
    }): Promise<{ count: number }>;
  };
  /**
   * The cross-company open-shift guard's only read. `count`, not `findMany`:
   * the answer this boundary is allowed to produce is a NUMBER, so no shift
   * row — no vehicle, no odometer, no notes, no defect, no company name —
   * can travel out of it. See `hasOpenShiftOutsideMembership`.
   */
  shift: {
    count(args: {
      where: { userId: string; status: { in: ShiftStatus[] }; membershipId: { not: string } };
    }): Promise<number>;
  };
}

function refreshSession(row: SessionRow): RefreshSession {
  return {
    id:        row.id,
    userId:    row.userId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    previousRefreshTokenGraceUntil: row.previousRefreshTokenGraceUntil,
  };
}

export function refreshRepository(db: RefreshDatabase) {
  return {
    /**
     * The Session a presented credential names, and which slot it filled.
     *
     * TWO unique lookups, in a fixed order, never one filter over both
     * columns. Current has PRECEDENCE: if a digest somehow appeared as one
     * Session's current and another's previous, the live credential wins and
     * the answer is deterministic — which is exactly the property F-21 said
     * was missing.
     *
     * Returns null for "no such credential". The caller must not distinguish
     * that from any other failure in its response.
     */
    async resolve(digest: string): Promise<ResolvedRefresh | null> {
      const current = await db.session.findUnique({ where: { refreshTokenHash: digest } });
      if (current !== null) return { session: refreshSession(current), matched: "current" };

      const previous = await db.session.findUnique({ where: { previousRefreshTokenHash: digest } });
      if (previous !== null) return { session: refreshSession(previous), matched: "previous" };

      return null;
    },

    /**
     * Rotate a CURRENT credential, atomically.
     *
     * The `where` clause restates every assumption: this Session, still
     * holding exactly the digest that was presented, still unrevoked, still
     * inside its absolute lifetime. Two simultaneous refreshes of the same
     * credential therefore both attempt the same conditional update and
     * exactly ONE of them can match — the loser sees `count === 0` and is
     * refused, instead of overwriting the winner's brand-new credential and
     * silently logging that client out.
     *
     * `expiresAt` is ABSENT from `data`, and that absence is the contract:
     * rotation changes credentials, never the Session's 90-day lifetime.
     *
     * Returns true only if this caller performed the rotation.
     */
    async rotateCurrent(input: {
      sessionId: string;
      presentedDigest: string;
      nextDigest: string;
      graceUntil: Date;
      now: Date;
    }): Promise<boolean> {
      return appliedOrNot(db.session.updateMany({
        where: {
          id:               input.sessionId,
          refreshTokenHash: input.presentedDigest,
          revokedAt:        null,
          expiresAt:        { gt: input.now },
        },
        data: {
          refreshTokenHash:               input.nextDigest,
          // The credential just superseded becomes the grace credential, so a
          // client whose response was lost can still recover with it.
          previousRefreshTokenHash:       input.presentedDigest,
          previousRefreshTokenGraceUntil: input.graceUntil,
        },
      }));
    },

    /**
     * Rotate from a PREVIOUS credential inside its grace window — the
     * lost-response recovery path, atomically.
     *
     * What it deliberately does NOT touch: `previousRefreshTokenHash` and
     * `previousRefreshTokenGraceUntil`. Only a fresh current digest is
     * written. Two consequences, both intended:
     *
     *   - the presented credential stays the recovery anchor, so a client
     *     that loses the response AGAIN can retry with the same secret;
     *   - the deadline is NOT extended, so repeated retries cannot stretch
     *     the window — a stolen previous credential is usable for the
     *     original 60 seconds and not one second longer.
     *
     * The grace deadline is checked IN the `where` clause, not read first and
     * compared in JavaScript, so a credential that expires between a read and
     * a write cannot slip through.
     *
     * One lineage survives: the intermediate current digest this replaces was
     * only ever returned in a response that never arrived, so nothing holds
     * it, and after this call nothing can present it.
     */
    async rotateFromGrace(input: {
      sessionId: string;
      presentedDigest: string;
      nextDigest: string;
      now: Date;
    }): Promise<boolean> {
      return appliedOrNot(db.session.updateMany({
        where: {
          id:                             input.sessionId,
          previousRefreshTokenHash:       input.presentedDigest,
          previousRefreshTokenGraceUntil: { gt: input.now },
          revokedAt:                      null,
          expiresAt:                      { gt: input.now },
        },
        data: { refreshTokenHash: input.nextDigest },
      }));
    },

    /**
     * Revoke a Session — logout, and credential reuse outside the grace
     * window (AUTH.md: "Reuse of a token older than the grace window revokes
     * the session").
     *
     * Conditioned on `revokedAt: null` so the FIRST revocation timestamp is
     * the one kept: a second call cannot move the moment a session ended.
     * Idempotent from the caller's point of view — `false` means "it was
     * already revoked", which is not a failure.
     */
    async revoke(sessionId: string, at: Date): Promise<boolean> {
      const { count } = await db.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data:  { revokedAt: at },
      });
      return count === 1;
    },

    /**
     * Does this user have an open shift under some OTHER membership?
     *
     * The cross-company invariant behind AUTH.md's "a switch is refused while
     * the driver has an open (draft) shift": one open shift at a time, and
     * "which company is this shift for" must never be ambiguous.
     *
     * Deliberately scoped as "outside THIS membership" rather than "anywhere".
     * A driver whose open shift belongs to the membership being selected is
     * not ambiguous at all — refusing them would lock them out of their own
     * open shift, which is the opposite of what the rule protects.
     *
     * This is the ONE sanctioned cross-tenant read in the product, and its
     * narrowness is the reason it is allowed to exist:
     *
     *   - the identity comes from the authenticated Session, never from the
     *     client — there is no `userId` parameter a route could forward;
     *   - the delegate is `count`, so the return value is a NUMBER and no
     *     shift row can leave;
     *   - the result is collapsed to a boolean here, so not even the count
     *     escapes and the caller cannot learn HOW MANY companies are involved.
     *
     * It must never grow a sibling that returns rows.
     */
    async hasOpenShiftOutsideMembership(userId: string, membershipId: string): Promise<boolean> {
      const open = await db.shift.count({
        where: {
          userId,
          status:       { in: [...OPEN_SHIFT_STATUSES] },
          membershipId: { not: membershipId },
        },
      });
      return open > 0;
    },
  };
}

export type RefreshRepository = ReturnType<typeof refreshRepository>;
