/**
 * The account routes: register, and read the authenticated account (D21).
 *
 * Two postures, both stated explicitly at the registration site so a reader
 * sees them without knowing the hook's default:
 *
 *   POST /auth/register   public    — there is no identity yet to authenticate
 *   GET  /auth/me         identity  — an account, with or without a company
 *
 * Neither touches Prisma, neither reads tenant identity out of the payload,
 * and neither decides anything: they parse input into a DTO and hand it, with
 * the trusted context, to the service (AUTH.md's trust boundary).
 *
 * There is deliberately no route here that can produce a `TenantContext`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";
import type { IdentityContext } from "../lib/auth.js";
import { AppError } from "../lib/errors.js";
import type { IdentityRepository } from "../repositories/identityRepository.js";
import { RegisterBody, accountView, register } from "../services/registration.js";

/**
 * The authenticated ACCOUNT identity, narrowed.
 *
 * `request.identity` is optional at the type level because a public route
 * never runs requireSession. On an identity route the hook has already run,
 * so an absent context is a wiring defect, not a client error — it fails
 * closed as an internal fault (logged, masked to 500) rather than being
 * dressed up as a 401, which would make a broken registration look like an
 * ordinary rejection.
 */
function identified(identity: IdentityContext | undefined): IdentityContext {
  if (identity === undefined) throw new Error("identity route reached with no IdentityContext");
  return identity;
}

/**
 * A Zod failure in the project's one error envelope.
 *
 * Only the field path and the message travel. `password` is EXCLUDED from
 * the details entirely: Zod's issues do not carry the input value, but a
 * future custom refinement could easily interpolate one into its message,
 * and a validation response is the last place a credential should be able to
 * appear. The rule the driver needs is stable text the client already knows.
 */
function invalidRequest(error: ZodError): AppError {
  const details = error.issues.map(issue => ({
    path:    issue.path.join("."),
    message: issue.path[0] === "password" ? "Password does not meet the requirements" : issue.message,
  }));
  return new AppError(400, "Invalid request", "VALIDATION", details);
}

export function registerAuthRoutes(app: FastifyInstance, accounts: IdentityRepository): void {
  app.post(
    "/auth/register",
    { config: { authPosture: "public" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RegisterBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      // `app.jwt` is the minter. The route hands it over rather than the
      // service reaching for a global, so the signing capability travels
      // through one visible parameter.
      const result = await register(parsed.data, accounts, app.jwt);
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/auth/me",
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest) => {
      return accountView(identified(request.identity).userId, accounts);
    },
  );
}
