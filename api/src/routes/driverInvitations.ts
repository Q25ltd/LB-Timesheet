/**
 * A driver's invitations (D63, stage 3):
 *
 *   GET  /driver/invitations              identity — my open invitations
 *   POST /driver/invitations/:id/accept   identity — join that company
 *   POST /driver/invitations/:id/decline  identity — say no to it
 *
 * Identity posture: a driver with no company yet has no tenant token, and an
 * invitation is an ACCOUNT's business — the service decides which account
 * kinds may answer (drivers, verified). Routes only parse; accept and decline
 * take no body.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityContext } from "../lib/auth.js";
import { invalidRequest, NoBody } from "../lib/requestValidation.js";
import type { DriverInvitationAnswerRepository } from "../repositories/driverInvitationAnswerRepository.js";
import type { IdentityRepository } from "../repositories/identityRepository.js";
import { AnswerParams, acceptInvitation, declineInvitation, listMyInvitations } from "../services/driverInvitationAnswers.js";

/** See `routes/auth.ts`: an identity route reached without its context is a wiring defect. */
function identified(identity: IdentityContext | undefined): IdentityContext {
  if (identity === undefined) throw new Error("identity route reached with no IdentityContext");
  return identity;
}

export function registerDriverInvitationRoutes(app: FastifyInstance, accounts: IdentityRepository, answers: DriverInvitationAnswerRepository): void {
  app.get(
    "/driver/invitations",
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest) => ({ invitations: await listMyInvitations(identified(request.identity), accounts, answers) }),
  );

  app.post(
    "/driver/invitations/:id/accept",
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest) => {
      const params = AnswerParams.safeParse(request.params);
      if (!params.success) throw invalidRequest(params.error);
      const body = NoBody.safeParse(request.body);
      if (!body.success) throw invalidRequest(body.error);
      return { membership: await acceptInvitation(identified(request.identity), params.data.id, accounts, answers) };
    },
  );

  app.post(
    "/driver/invitations/:id/decline",
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = AnswerParams.safeParse(request.params);
      if (!params.success) throw invalidRequest(params.error);
      const body = NoBody.safeParse(request.body);
      if (!body.success) throw invalidRequest(body.error);
      await declineInvitation(identified(request.identity), params.data.id, accounts, answers);
      return reply.status(204).send();
    },
  );
}
