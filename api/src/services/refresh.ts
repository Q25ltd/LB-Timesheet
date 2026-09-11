/**
 * Refresh-token redemption and rotation (AUTH.md "Refresh token", F-21).
 *
 * THE CREDENTIAL AUTHENTICATES THE REQUEST. No access token is required or
 * read: the whole point of this endpoint is that the caller's identity token
 * has expired. It is the one place in the product where authority arrives in
 * a body rather than an `Authorization` header, which is why the body is
 * exactly one field and the route is the only caller.
 *
 * THE FOUR OUTCOMES, and they are indistinguishable from outside:
 *
 *   current credential          → rotate, return new material
 *   previous, inside grace      → recovery-rotate, return new material
 *   previous, outside grace     → REUSE: revoke the Session, then 401
 *   anything else               → 401
 *
 * "Anything else" covers a credential that matches nothing, a Session that is
 * revoked, one past its absolute expiry, and a lost rotation race. Every one
 * of them produces the identical canonical body, so refresh cannot be probed
 * for whether a session exists, whether it was revoked, whether it expired,
 * or which digest column matched.
 *
 * WHAT ROTATION DOES NOT DO: it never moves `Session.expiresAt`. The 90-day
 * absolute lifetime is the Session's, and rotating credentials inside it is
 * not a reason to extend it (AUTH.md).
 */
import { z } from "zod";
import type { JWT } from "@fastify/jwt";
import { AppError } from "../lib/errors.js";
import {
  hashRefreshToken,
  mintIdentityToken,
  mintRefreshToken,
  REFRESH_GRACE_MS,
} from "../lib/tokens.js";
import type { RefreshRepository } from "../repositories/refreshRepository.js";

/**
 * Exactly one field. `.strict()` is the mechanism: a client sending
 * `sessionId`, `userId`, `companyId`, `membershipId` or `role` is REFUSED,
 * not ignored. The server derives every one of those from the credential —
 * a refresh request that could name its own Session would be a refresh
 * request that could name someone else's.
 *
 * A refresh secret is 32 random bytes base64url-encoded, so 43 characters;
 * the cap is CLAUDE.md's 64 for a code or reference, which bounds a public
 * endpoint without pinning the encoding.
 */
export const RefreshBody = z.object({
  refreshToken: z.string().min(1).max(64),
}).strict();

export type RefreshInput = z.infer<typeof RefreshBody>;

/**
 * The success body. Deliberately the same two names the account boundary
 * already uses, and deliberately NOT the user or the membership list: a
 * refresh restores CREDENTIALS, and the client reads its account state from
 * `/auth/me` with the token it just received. One concept, one owner.
 */
export interface RefreshResult {
  identityToken: string;
  refreshToken: string;
}

/** The one failure, identical to every other authentication failure (D17). */
function notAuthenticated(): AppError {
  return new AppError(401, "Not authenticated", "UNAUTHENTICATED");
}

export async function refresh(
  input: RefreshInput,
  sessions: RefreshRepository,
  jwt: JWT,
): Promise<RefreshResult> {
  const now = new Date();
  const presentedDigest = hashRefreshToken(input.refreshToken);

  // TWO unique lookups with current precedence, inside the repository — never
  // one filter across both digest columns (F-21). The repository's database
  // interface cannot express the ambiguous query at all.
  const resolved = await sessions.resolve(presentedDigest);
  if (resolved === null) throw notAuthenticated();

  const { session, matched } = resolved;

  // Read here for the fast, common rejections. They are NOT the guarantee —
  // every conditional write below restates them in its `where` clause, so a
  // session revoked between this check and that write still cannot rotate.
  if (session.revokedAt !== null) throw notAuthenticated();
  if (session.expiresAt.getTime() <= now.getTime()) throw notAuthenticated();

  // The plaintext exists only in this scope and in the response; what is
  // stored is provably its digest.
  const nextToken = mintRefreshToken();
  const nextDigest = hashRefreshToken(nextToken);

  if (matched === "previous") {
    const graceUntil = session.previousRefreshTokenGraceUntil;

    // REUSE. A superseded credential presented after its window is either a
    // stolen one or a client that has been offline far longer than a lost
    // response could explain. AUTH.md: it revokes the session, which logs
    // every holder of that lineage out and forces a full password login.
    //
    // HONEST LIMITATION: the schema holds ONE previous digest, so this
    // detects reuse of the immediately-superseded credential only. A
    // credential two or more rotations old matches nothing and is refused as
    // an unknown credential above — it does NOT revoke the session, because
    // the server has no record that it ever existed. This boundary is not a
    // general replay detector and must not be described as one.
    if (graceUntil === null || graceUntil.getTime() <= now.getTime()) {
      await sessions.revoke(session.id, now);
      throw notAuthenticated();
    }

    // Recovery: the response to a successful rotation was lost and the client
    // retried with the only secret it still holds. Atomic, and it leaves the
    // previous digest and its deadline untouched — so a further lost response
    // can be retried with the same secret, and repeated retries cannot
    // stretch the window.
    const recovered = await sessions.rotateFromGrace({
      sessionId:       session.id,
      presentedDigest,
      nextDigest,
      now,
    });
    // Lost the race, or the deadline passed between the read and the write.
    // Refused generically rather than retried: a retry loop here would be a
    // way to keep guessing at a moving target.
    if (!recovered) throw notAuthenticated();

    return {
      identityToken: mintIdentityToken(jwt, { userId: session.userId, sessionId: session.id }),
      refreshToken:  nextToken,
    };
  }

  // The ordinary path: a live credential, rotated atomically. The old current
  // becomes the grace credential with a fresh 60-second deadline.
  const rotated = await sessions.rotateCurrent({
    sessionId:       session.id,
    presentedDigest,
    nextDigest,
    graceUntil:      new Date(now.getTime() + REFRESH_GRACE_MS),
    now,
  });
  // Another request rotated this same credential first. Exactly one caller
  // may win; the loser is refused and its client can recover through the
  // grace window, because the credential it holds is now the previous one.
  if (!rotated) throw notAuthenticated();

  return {
    identityToken: mintIdentityToken(jwt, { userId: session.userId, sessionId: session.id }),
    refreshToken:  nextToken,
  };
}

/**
 * Log out: revoke THIS session, server-side.
 *
 * Takes the session id from the authenticated `IdentityContext`, never from a
 * body — a logout that could name its own session could log out somebody
 * else's device. There is no DTO here for the same reason: the request has
 * nothing to say.
 *
 * Idempotent. Revoking an already-revoked session is a success, because the
 * caller's goal — "this session must not work any more" — is already true,
 * and answering 4xx would tell a client to retry something that cannot help.
 */
export async function logout(sessionId: string, sessions: RefreshRepository): Promise<void> {
  await sessions.revoke(sessionId, new Date());
}
