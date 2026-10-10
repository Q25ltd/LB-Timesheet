/**
 * A company adds its drivers (D63, stage 1) — the company website's
 * invitation routes:
 *
 *   POST  /company/driver-invitations              tenant — add a driver
 *   GET   /company/driver-invitations              tenant — this company's invitations
 *   PATCH /company/driver-invitations/:id          tenant — correct a pending one
 *   POST  /company/driver-invitations/:id/cancel   tenant — cancel a pending one
 *
 * Tenant posture under the default-deny hook; the SERVICE applies D54's
 * company-admin gate, so a driver's tenant token is refused there. Nothing
 * here reads a company from the request: the company is the token's
 * membership's. Routes only parse, and hand the parsed input on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "../lib/auth.js";
import { invalidRequest, NoBody } from "../lib/requestValidation.js";
import type { DriverInvitationRepository } from "../repositories/driverInvitationRepository.js";
import {
  AddDriverBody,
  CorrectInvitationBody,
  InvitationParams,
  addDriver,
  cancelInvitation,
  correctInvitation,
  listInvitations,
  type InvitationMail,
} from "../services/driverInvitations.js";

const DRIVER_INVITATIONS = "/company/driver-invitations";

/** A protected route reached without an AuthContext is a wiring defect, not a client error. */
function authenticated(auth: AuthContext | undefined): AuthContext {
  if (auth === undefined) throw new Error("protected route reached with no AuthContext");
  return auth;
}

export function registerCompanyDriverRoutes(app: FastifyInstance, invitations: DriverInvitationRepository, mail: InvitationMail): void {
  app.post(
    DRIVER_INVITATIONS,
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = AddDriverBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      const invitation = await addDriver(authenticated(request.auth), parsed.data, invitations, mail);
      return reply.status(201).send({ invitation });
    },
  );

  app.get(
    DRIVER_INVITATIONS,
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest) => ({ invitations: await listInvitations(authenticated(request.auth), invitations) }),
  );

  app.patch(
    `${DRIVER_INVITATIONS}/:id`,
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest) => {
      const params = InvitationParams.safeParse(request.params);
      if (!params.success) throw invalidRequest(params.error);
      const parsed = CorrectInvitationBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      return { invitation: await correctInvitation(authenticated(request.auth), params.data.id, parsed.data, invitations) };
    },
  );

  app.post(
    `${DRIVER_INVITATIONS}/:id/cancel`,
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest) => {
      const params = InvitationParams.safeParse(request.params);
      if (!params.success) throw invalidRequest(params.error);
      const parsed = NoBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      return { invitation: await cancelInvitation(authenticated(request.auth), params.data.id, invitations) };
    },
  );
}
