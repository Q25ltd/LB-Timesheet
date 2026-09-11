/**
 * The account routes: the complete authentication lifecycle (D21).
 *
 * Every posture is stated explicitly at its registration site, so a reader
 * sees it without having to know the hook's default:
 *
 *   POST /auth/register        public    — there is no identity yet
 *   POST /auth/login           public    — proving identity IS the point
 *   POST /auth/refresh         public    — the CREDENTIAL authenticates it;
 *                                          the caller's access token has
 *                                          expired, which is why it is here
 *   POST /auth/logout          identity  — revokes the caller's own session
 *   POST /auth/switch-company  identity  — account-level; yields TENANT
 *                                          authority from a validated row
 *   GET  /auth/me              identity  — an account, with or without a company
 *
 * `public` on `/auth/refresh` means "no Authorization header is required",
 * not "unauthenticated": the refresh secret is the credential, and it is
 * verified against a persisted Session digest before anything is issued. It
 * cannot be marked `identity` precisely because an identity token is what the
 * caller no longer has.
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
import type { RefreshRepository } from "../repositories/refreshRepository.js";
import { SwitchCompanyBody, switchCompany } from "../services/companySwitch.js";
import { LoginBody, login } from "../services/login.js";
import { RefreshBody, logout, refresh } from "../services/refresh.js";
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

export function registerAuthRoutes(
  app: FastifyInstance,
  accounts: IdentityRepository,
  sessions: RefreshRepository,
): void {
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

  app.post(
    "/auth/login",
    // Public for the same reason registration is: a driver logging in has no
    // token by definition. A stale identity token the phone still holds in
    // memory is irrelevant here and is never verified — the body decides.
    { config: { authPosture: "public" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = LoginBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      // 200, not 201: authenticating creates a Session, but the resource the
      // caller asked about — the account — already existed. Registration's
      // 201 is for the account it creates.
      const result = await login(parsed.data, accounts, app.jwt);
      return reply.status(200).send(result);
    },
  );

  app.post(
    "/auth/refresh",
    // Public in the POSTURE sense only: no access token is required, because
    // the caller's has expired. The refresh secret in the body is the
    // credential, and the service verifies its digest against a live Session
    // before issuing anything.
    { config: { authPosture: "public" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RefreshBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      const result = await refresh(parsed.data, sessions, app.jwt);
      return reply.status(200).send(result);
    },
  );

  app.post(
    "/auth/logout",
    // Identity posture: the session being revoked is the one the token names.
    // There is no body — a logout that could name its own session could log
    // out somebody else's device.
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await logout(identified(request.identity).sessionId, sessions);
      // 204: the session is gone and there is nothing to describe.
      return reply.status(204).send();
    },
  );

  app.post(
    "/auth/switch-company",
    // Identity posture, and that is the interesting part: an ACCOUNT-level
    // token is what may ASK for tenant authority. The tenant token this
    // returns is minted from the membership row the server loads, so the
    // request cannot carry the authority it is requesting.
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SwitchCompanyBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      const result = await switchCompany(parsed.data, identified(request.identity), accounts, sessions, app.jwt);
      return reply.status(200).send(result);
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
