/**
 * DEVELOPMENT ONLY — the verification link the development outbox received,
 * for the signed-in account it was sent to.
 *
 *   GET /dev/email-verification-link   identity — 200 { link } | 404
 *
 * Why: in development email is not delivered — the mailer writes each
 * message to `api/.mail-outbox/` — so a developer registering a company would
 * otherwise have to dig the link out of a JSON file. This hands over the SAME
 * link that file contains. It verifies nothing and creates nothing: the
 * developer opens the link, and the normal confirmation does the rest.
 *
 * WHERE IT EXISTS. `app.ts` registers this file only when the mail transport
 * is the development outbox (`mailTransportFor(...).outbox !== null`):
 * `NODE_ENV=development` with no provider key. In production — which cannot
 * boot without a key — and in test, the route is not registered at all, so
 * there is nothing to reach, refuse or misconfigure.
 *
 * Even in development it is identity-authenticated and hands an account only
 * ITS OWN live link: the outbox message must carry the token stored for this
 * account right now.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityContext } from "../lib/auth.js";
import { findVerificationLink } from "../lib/devOutbox.js";
import { AppError } from "../lib/errors.js";
import type { AccountTokenRepository } from "../repositories/accountTokenRepository.js";
import type { IdentityRepository } from "../repositories/identityRepository.js";

/** See `routes/auth.ts`: an identity route reached without its context is a wiring defect. */
function identified(identity: IdentityContext | undefined): IdentityContext {
  if (identity === undefined) throw new Error("identity route reached with no IdentityContext");
  return identity;
}

export function registerDevEmailRoutes(
  app: FastifyInstance,
  accounts: IdentityRepository,
  tokens: AccountTokenRepository,
  outbox: string,
): void {
  app.get(
    "/dev/email-verification-link",
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = identified(request.identity);
      const state = await accounts.findAccountState(userId);
      if (state === null) throw new AppError(401, "Not authenticated", "UNAUTHENTICATED");

      const tokenHash = await tokens.liveTokenHash(userId, "email_verification", new Date());
      const link = tokenHash === null ? null : await findVerificationLink(outbox, state.user.email, tokenHash);
      if (link === null) throw new AppError(404, "No verification email in the development outbox", "NOT_FOUND");
      return reply.status(200).send({ link });
    },
  );
}
