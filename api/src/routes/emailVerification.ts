/**
 * Email-ownership verification routes (owner decision B4).
 *
 *   POST /auth/email-verification          identity — (re)send to MY address
 *   POST /auth/email-verification/confirm  public   — the emailed token is
 *                                                     the credential
 *
 * Neither touches the refresh cookie, so neither needs the Origin guard: the
 * first is bearer-authenticated, and the second can do nothing without a
 * secret only the mailbox holds.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityContext } from "../lib/auth.js";
import { invalidRequest, NoBody } from "../lib/requestValidation.js";
import type { AccountTokenRepository } from "../repositories/accountTokenRepository.js";
import type { IdentityRepository } from "../repositories/identityRepository.js";
import {
  ConfirmEmailBody,
  confirmEmail,
  requestEmailVerification,
  type AccountMail,
} from "../services/emailVerification.js";

/** See `routes/auth.ts`: an identity route reached without its context is a wiring defect. */
function identified(identity: IdentityContext | undefined): IdentityContext {
  if (identity === undefined) throw new Error("identity route reached with no IdentityContext");
  return identity;
}

export function registerEmailVerificationRoutes(
  app: FastifyInstance,
  accounts: IdentityRepository,
  tokens: AccountTokenRepository,
  mail: AccountMail,
): void {
  app.post(
    "/auth/email-verification",
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = NoBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      await requestEmailVerification(identified(request.identity).userId, accounts, tokens, mail);
      return reply.status(204).send();
    },
  );

  app.post(
    "/auth/email-verification/confirm",
    { config: { authPosture: "public" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ConfirmEmailBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      await confirmEmail(parsed.data, tokens);
      return reply.status(204).send();
    },
  );
}
