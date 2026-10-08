/**
 * `POST /auth/email/correction` — identity posture (D56). See
 * services/emailCorrection.ts for who may correct an address and when.
 *
 * Rate-limited with sign-in's bucket: it verifies a password, so it must not
 * be a cheaper way to guess one.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityContext } from "../lib/auth.js";
import type { AuthRateLimits } from "../lib/authRateLimits.js";
import { invalidRequest } from "../lib/requestValidation.js";
import { CorrectEmailBody, correctEmail, type EmailCorrectionDeps } from "../services/emailCorrection.js";

/** See `routes/auth.ts`: an identity route reached without its context is a wiring defect. */
function identified(identity: IdentityContext | undefined): IdentityContext {
  if (identity === undefined) throw new Error("identity route reached with no IdentityContext");
  return identity;
}

export function registerEmailCorrectionRoutes(app: FastifyInstance, deps: EmailCorrectionDeps, limits: AuthRateLimits): void {
  app.post(
    "/auth/email/correction",
    { config: { authPosture: "identity" }, onRequest: limits.login },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CorrectEmailBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      await correctEmail(identified(request.identity).userId, parsed.data, deps);
      return reply.status(204).send();
    },
  );
}
