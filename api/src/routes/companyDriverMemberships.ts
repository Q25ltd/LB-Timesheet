/**
 * A company manages its drivers (D65) — the company website's routes:
 *
 *   GET  /company/drivers                          tenant — this company's drivers
 *   POST /company/drivers/:membershipId/deactivate tenant — no new shifts; history kept
 *   POST /company/drivers/:membershipId/reactivate tenant — eligible again
 *   POST /company/drivers/:membershipId/remove     tenant — gone from the list; may be invited again
 *
 * Tenant posture under the default-deny hook; the SERVICE applies D54's
 * company-admin gate. The actions take no body: the company is the token's,
 * the membership is the path's, and the state is the action's.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "../lib/auth.js";
import { invalidRequest, NoBody } from "../lib/requestValidation.js";
import type { CompanyDriverRepository, DriverAction } from "../repositories/companyDriverRepository.js";
import { DriverParams, changeDriver, listDrivers } from "../services/companyDrivers.js";

const DRIVERS = "/company/drivers";
const ACTIONS: readonly DriverAction[] = ["deactivate", "reactivate", "remove"];

/** A protected route reached without an AuthContext is a wiring defect, not a client error. */
function authenticated(auth: AuthContext | undefined): AuthContext {
  if (auth === undefined) throw new Error("protected route reached with no AuthContext");
  return auth;
}

export function registerCompanyDriverMembershipRoutes(app: FastifyInstance, drivers: CompanyDriverRepository): void {
  app.get(
    DRIVERS,
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest) => ({ drivers: await listDrivers(authenticated(request.auth), drivers) }),
  );

  for (const action of ACTIONS) {
    app.post(
      `${DRIVERS}/:membershipId/${action}`,
      { config: { authPosture: "tenant" } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const params = DriverParams.safeParse(request.params);
        if (!params.success) throw invalidRequest(params.error);
        const parsed = NoBody.safeParse(request.body);
        if (!parsed.success) throw invalidRequest(parsed.error);
        const driver = await changeDriver(authenticated(request.auth), params.data.membershipId, action, drivers);
        return reply.status(200).send({ driver });
      },
    );
  }
}
