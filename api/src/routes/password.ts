/**
 * Password recovery and change (owner decision B7).
 *
 *   POST /auth/password/forgot  public    — always 204; the work runs after the reply
 *   POST /auth/password/reset   public    — the emailed token is the credential
 *   POST /auth/password/change  identity  — the signed-in account, current password required
 *
 * None of them reads or sets the refresh cookie, so none needs the Origin
 * guard. A reset revokes the browser's session server-side; that browser's
 * next cookie refresh is refused and clears the cookie.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityContext } from "../lib/auth.js";
import type { BackgroundWork } from "../lib/backgroundWork.js";
import { invalidRequest } from "../lib/requestValidation.js";
import type { AccountTokenRepository } from "../repositories/accountTokenRepository.js";
import type { IdentityRepository } from "../repositories/identityRepository.js";
import type { PasswordRepository } from "../repositories/passwordRepository.js";
import type { AccountMail } from "../services/emailVerification.js";
import {
  ChangePasswordBody,
  ForgotPasswordBody,
  ResetPasswordBody,
  changePassword,
  forgotPassword,
  resetPassword,
} from "../services/password.js";

/** See `routes/auth.ts`: an identity route reached without its context is a wiring defect. */
function identified(identity: IdentityContext | undefined): IdentityContext {
  if (identity === undefined) throw new Error("identity route reached with no IdentityContext");
  return identity;
}

export function registerPasswordRoutes(
  app: FastifyInstance,
  accounts: IdentityRepository,
  tokens: AccountTokenRepository,
  passwords: PasswordRepository,
  mail: AccountMail,
  work: BackgroundWork,
): void {
  app.post(
    "/auth/password/forgot",
    { config: { authPosture: "public" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ForgotPasswordBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      forgotPassword(parsed.data, accounts, tokens, mail, work);
      return reply.status(204).send();
    },
  );

  app.post(
    "/auth/password/reset",
    { config: { authPosture: "public" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ResetPasswordBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      await resetPassword(parsed.data, passwords);
      return reply.status(204).send();
    },
  );

  app.post(
    "/auth/password/change",
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ChangePasswordBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      await changePassword(parsed.data, identified(request.identity), passwords);
      return reply.status(204).send();
    },
  );
}
