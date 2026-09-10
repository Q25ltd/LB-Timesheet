/**
 * The first protected business routes: start a shift, and recover the open one.
 *
 * Both sit behind the default-deny `onRequest` hook in app.ts (F-10) and
 * declare `authPosture: "tenant"` so the posture is visible on read. Neither touches
 * Prisma, neither reads tenant identity out of the payload, and neither
 * decides anything — they parse input into a DTO and hand it, with the trusted
 * AuthContext, to the service (AUTH.md's trust boundary).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";
import type { AuthContext } from "../lib/auth.js";
import { AppError } from "../lib/errors.js";
import type { StartShiftRepository } from "../repositories/startShiftRepository.js";
import { StartShiftBody, currentShift, startShift } from "../services/startShift.js";

/**
 * The authenticated identity, narrowed.
 *
 * `request.auth` is optional at the type level because a PUBLIC route never
 * runs requireAuth. On a protected route the hook has already run, so an
 * absent context is a wiring defect, not a client error — it fails closed as
 * an internal fault (logged, masked to 500) rather than being dressed up as a
 * 401, which would make a broken registration look like an ordinary rejection.
 */
function authenticated(auth: AuthContext | undefined): AuthContext {
  if (auth === undefined) throw new Error("protected route reached with no AuthContext");
  return auth;
}

/**
 * A Zod failure in the project's one error envelope: the same 400 / VALIDATION
 * shape Fastify's schema path produces. Only the field path and the message
 * travel — never the parser's internal representation.
 */
function invalidRequest(error: ZodError): AppError {
  const details = error.issues.map(issue => ({
    path:    issue.path.join("."),
    message: issue.message,
  }));
  return new AppError(400, "Invalid request", "VALIDATION", details);
}

export function registerShiftRoutes(app: FastifyInstance, shifts: StartShiftRepository): void {
  app.post(
    "/shifts/start",
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = StartShiftBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      const result = await startShift(authenticated(request.auth), parsed.data, shifts);
      // 201 for a start that happened here, 200 for a replay of one that
      // already had — so an offline client can tell "accepted" from
      // "accepted, again" without a second call.
      return reply.status(result.created ? 201 : 200).send({ shift: result.shift });
    },
  );

  app.get(
    "/shifts/current",
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest) => {
      return { shift: await currentShift(authenticated(request.auth), shifts) };
    },
  );
}
