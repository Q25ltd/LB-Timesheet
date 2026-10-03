/**
 * The BROWSER transport for the account lifecycle (D45, D46).
 *
 *   POST /auth/web/register   public   — creates a BROWSER session
 *   POST /auth/web/login      public   — creates a BROWSER session
 *   POST /auth/web/refresh    public   — the COOKIE is the credential
 *   POST /auth/web/logout     public   — the COOKIE names the session
 *
 * These are transport adapters and nothing more. Registration, login,
 * rotation (with its grace and one-generation reuse detection) and revocation
 * are the SAME services the phone's routes call; what differs is only how the
 * refresh credential travels:
 *
 *   phone    the secret in the JSON body, both ways
 *   browser  the secret ONLY in an HttpOnly cookie; the body carries the
 *            short-lived access token, which the web app keeps in memory
 *
 * The client kind passed to each service is fixed HERE, by the route — never
 * read from the request — so a browser cannot ask to become a phone or the
 * reverse (D46).
 *
 * `public` means "no Authorization header required", exactly as on
 * `/auth/refresh`: the cookie is the credential and is verified against a
 * persisted Session digest before anything is issued. The access-token routes
 * (`/auth/me`, `/auth/switch-company`, `/auth/logout`) are shared with the
 * phone and stay bearer-authenticated — the API is not converted to cookie
 * authentication.
 *
 * Every route in this file runs behind ONE Origin guard, registered on the
 * scope rather than per route, so a route added here later cannot be
 * forgotten (D45's CSRF baseline).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import { requireTrustedOrigin } from "../lib/originGuard.js";
import type { AuthRateLimits } from "../lib/authRateLimits.js";
import type { BackgroundWork } from "../lib/backgroundWork.js";
import { invalidRequest, NoBody } from "../lib/requestValidation.js";
import {
  clearedRefreshCookie,
  readRefreshCookie,
  refreshCookie,
  type RefreshCookiePolicy,
} from "../lib/refreshCookie.js";
import type { AccountTokenRepository } from "../repositories/accountTokenRepository.js";
import type { IdentityRepository } from "../repositories/identityRepository.js";
import { issueEmailVerification, type AccountMail } from "../services/emailVerification.js";
import type { RefreshRepository } from "../repositories/refreshRepository.js";
import { LoginBody, login } from "../services/login.js";
import { logoutByCredential, refresh } from "../services/refresh.js";
import { RegisterBody, register } from "../services/registration.js";

/**
 * The path prefix every cookie-transport route lives under. `app.ts` grants
 * credentialed CORS to exactly these paths and no others (D45).
 */
export const WEB_AUTH_PREFIX = "/auth/web/";

/** The one failure, identical to every other authentication failure (D17). */
function notAuthenticated(): AppError {
  return new AppError(401, "Not authenticated", "UNAUTHENTICATED");
}

export async function registerWebAuthRoutes(
  app: FastifyInstance,
  accounts: IdentityRepository,
  sessions: RefreshRepository,
  cookies: RefreshCookiePolicy,
  allowedOrigins: readonly string[],
  tokens: AccountTokenRepository,
  mail: AccountMail,
  work: BackgroundWork,
  limits: AuthRateLimits,
): Promise<void> {
  await app.register((web, _options, done) => {
    // Every route registered on this scope — today's four and any added
    // later — is behind the Origin check. Runs after the root default-deny
    // hook and after CORS, so a preflight never reaches it.
    // A throw here is caught by Fastify's hook runner and answered through
    // the one error envelope, exactly like a rejected promise.
    web.addHook("onRequest", (request, _reply, next) => {
      requireTrustedOrigin(request.headers.origin, allowedOrigins);
      next();
    });

    web.post(
      `${WEB_AUTH_PREFIX}register`,
      { config: { authPosture: "public" }, onRequest: limits.registration },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const parsed = RegisterBody.safeParse(request.body);
        if (!parsed.success) throw invalidRequest(parsed.error);

        const { result, sessionExpiresAt } = await register(parsed.data, "browser", accounts, app.jwt);

        // A company-to-be starts by proving its address (B3, B4): the first
        // verification email is sent with the account. Delivery runs after
        // the reply — the account exists either way, a failure is logged,
        // and the account page can send another.
        const issued = await issueEmailVerification({ user: result.user, accountKind: "company", emailVerified: false }, tokens, mail);
        if (issued.kind === "ready") work.run("email-verification", issued.deliver);

        const { refreshToken, ...body } = result;
        void reply.header("set-cookie", refreshCookie(cookies, refreshToken, sessionExpiresAt, new Date()));
        return reply.status(201).send(body);
      },
    );

    web.post(
      `${WEB_AUTH_PREFIX}login`,
      { config: { authPosture: "public" }, onRequest: limits.login },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const parsed = LoginBody.safeParse(request.body);
        if (!parsed.success) throw invalidRequest(parsed.error);

        const { result, sessionExpiresAt } = await login(parsed.data, "browser", accounts, app.jwt);
        const { refreshToken, ...body } = result;
        void reply.header("set-cookie", refreshCookie(cookies, refreshToken, sessionExpiresAt, new Date()));
        return reply.status(200).send(body);
      },
    );

    web.post(
      `${WEB_AUTH_PREFIX}refresh`,
      { config: { authPosture: "public" } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const parsed = NoBody.safeParse(request.body);
        if (!parsed.success) throw invalidRequest(parsed.error);

        // On a REFUSAL the browser is told to drop a cookie that can no longer
        // do anything. On a FAULT — the database unreachable, say — nothing is
        // said about the cookie at all: the server has judged nothing, the
        // Session is still live, and clearing the cookie would sign the user
        // out for good over an outage they could have waited out.
        const refused = (): AppError => {
          void reply.header("set-cookie", clearedRefreshCookie(cookies));
          return notAuthenticated();
        };

        const secret = readRefreshCookie(request.headers.cookie, cookies);
        if (secret === null) throw refused();

        let issued: Awaited<ReturnType<typeof refresh>>;
        try {
          issued = await refresh({ refreshToken: secret }, "browser", sessions, app.jwt);
        } catch (error) {
          // The service has exactly one refusal (D17); everything else is a fault.
          if (error instanceof AppError && error.statusCode === 401) throw refused();
          throw error;
        }

        const { result, sessionExpiresAt } = issued;
        void reply.header("set-cookie", refreshCookie(cookies, result.refreshToken, sessionExpiresAt, new Date()));
        return reply.status(200).send({ identityToken: result.identityToken });
      },
    );

    web.post(
      `${WEB_AUTH_PREFIX}logout`,
      { config: { authPosture: "public" } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const parsed = NoBody.safeParse(request.body);
        if (!parsed.success) throw invalidRequest(parsed.error);

        void reply.header("set-cookie", clearedRefreshCookie(cookies));
        await logoutByCredential(readRefreshCookie(request.headers.cookie, cookies), "browser", sessions);
        return reply.status(204).send();
      },
    );

    done();
  });
}
