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
import type { SessionClientKind } from "../generated/enums.js";
import { AppError } from "../lib/errors.js";
import {
  hashRefreshToken,
  mintIdentityToken,
  mintRefreshToken,
  REFRESH_GRACE_MS,
  type IssuedUnderSession,
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

/**
 * THE rotation authority, for every transport (owner decision B1).
 *
 * `transport` is the client kind whose transport delivered the credential —
 * `mobile` for the JSON body, `browser` for the HttpOnly cookie — and it is
 * supplied by the ROUTE that owns that transport, never by the caller's
 * request. A credential belonging to a Session of the other kind is refused
 * exactly like an unknown one: a browser secret in a body has left its
 * cookie, and a mobile secret in a cookie never belonged in one.
 *
 * The refusal does NOT revoke. Revocation is the reuse decision AUTH.md
 * specifies; a credential arriving through the wrong transport is a different
 * event, and no decision has been made to treat it as reuse.
 */
export async function refresh(
  input: RefreshInput,
  transport: SessionClientKind,
  sessions: RefreshRepository,
  jwt: JWT,
): Promise<IssuedUnderSession<RefreshResult>> {
  const now = new Date();
  const presentedDigest = hashRefreshToken(input.refreshToken);

  // TWO unique lookups with current precedence, inside the repository — never
  // one filter across both digest columns (F-21). The repository's database
  // interface cannot express the ambiguous query at all.
  const resolved = await sessions.resolve(presentedDigest);
  if (resolved === null) throw notAuthenticated();

  const { session, matched } = resolved;

  // Checked BEFORE reuse detection, so a credential presented through the
  // wrong transport can neither rotate nor trigger a revocation. Restated in
  // every conditional write below, so the database refuses it as well.
  if (session.clientKind !== transport) throw notAuthenticated();

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
      clientKind:      transport,
      presentedDigest,
      nextDigest,
      now,
    });
    // Lost the race, or the deadline passed between the read and the write.
    // Refused generically rather than retried: a retry loop here would be a
    // way to keep guessing at a moving target.
    if (!recovered) throw notAuthenticated();

    return {
      result: {
        identityToken: mintIdentityToken(jwt, { userId: session.userId, sessionId: session.id }),
        refreshToken:  nextToken,
      },
      sessionExpiresAt: session.expiresAt,
    };
  }

  // The ordinary path: a live credential, rotated atomically. The old current
  // becomes the grace credential with a fresh 60-second deadline.
  const rotated = await sessions.rotateCurrent({
    sessionId:       session.id,
    clientKind:      transport,
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
    result: {
      identityToken: mintIdentityToken(jwt, { userId: session.userId, sessionId: session.id }),
      refreshToken:  nextToken,
    },
    // Unchanged by rotation — the conditional write never touches it.
    sessionExpiresAt: session.expiresAt,
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

/**
 * Log out by the refresh CREDENTIAL — the browser's logout, where the cookie
 * is the one thing the browser reliably holds (its in-memory access token may
 * already be gone).
 *
 * The credential names the session, through the same F-21 resolution refresh
 * uses (current first, previous only if current missed), and only a session
 * of the transport's own kind may be revoked: the cookie transport cannot act
 * on a phone's session (D46).
 *
 * Idempotent and silent: no credential, an unknown one or one of the wrong
 * kind is not an error. The caller's goal — "this browser holds no usable
 * session" — is achieved by clearing the cookie either way, and answering
 * differently would make logout an oracle for which credentials exist.
 */
export async function logoutByCredential(
  refreshToken: string | null,
  transport: SessionClientKind,
  sessions: RefreshRepository,
): Promise<void> {
  if (refreshToken === null) return;
  const resolved = await sessions.resolve(hashRefreshToken(refreshToken));
  if (resolved === null || resolved.session.clientKind !== transport) return;
  await sessions.revoke(resolved.session.id, new Date());
}
