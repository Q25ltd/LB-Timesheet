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
 *
 * These are the PHONE's transport (refresh secret in the body). The browser's
 * transport for the same lifecycle — the secret in an HttpOnly cookie — is
 * `routes/webAuth.ts`, calling the same services (D45, D46).
 */
import type { EmailDeliveryRepository } from "../repositories/emailDeliveryRepository.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityContext } from "../lib/auth.js";
import type { AuthRateLimits } from "../lib/authRateLimits.js";
import { invalidRequest } from "../lib/requestValidation.js";
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

export function registerAuthRoutes(
  app: FastifyInstance,
  accounts: IdentityRepository,
  sessions: RefreshRepository,
  limits: AuthRateLimits,
  delivery: EmailDeliveryRepository,
): void {
  app.post(
    "/auth/register",
    // B6: shares ONE bucket with the browser's registration.
    { config: { authPosture: "public" }, onRequest: limits.registration },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RegisterBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      // `app.jwt` is the minter. The route hands it over rather than the
      // service reaching for a global, so the signing capability travels
      // through one visible parameter.
      // The phone's endpoint: a MOBILE session, its secret in the body (D46).
      const { result } = await register(parsed.data, "mobile", accounts, app.jwt);
      return reply.status(201).send(result);
    },
  );

  app.post(
    "/auth/login",
    // Public for the same reason registration is: a driver logging in has no
    // token by definition. A stale identity token the phone still holds in
    // memory is irrelevant here and is never verified — the body decides.
    { config: { authPosture: "public" }, onRequest: limits.login },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = LoginBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      // 200, not 201: authenticating creates a Session, but the resource the
      // caller asked about — the account — already existed. Registration's
      // 201 is for the account it creates.
      const { result } = await login(parsed.data, "mobile", accounts, app.jwt);
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

      // The BODY transport is the phone's (B1): only a mobile Session's
      // credential may be redeemed here.
      const { result } = await refresh(parsed.data, "mobile", sessions, app.jwt);
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
      return accountView(identified(request.identity).userId, accounts, delivery);
    },
  );
}
