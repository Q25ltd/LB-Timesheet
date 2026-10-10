import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { env } from "./lib/env.js";
import { allowedOrigins, webAppUrl, type ClientIpSource } from "./lib/env.schema.js";
import { clientAddressOf } from "./lib/clientAddress.js";
import { AppError, registerErrorHandling } from "./lib/errors.js";
import { requireAuth, requireSession } from "./lib/auth.js";
import { TENANT_VERIFY_OPTIONS } from "./lib/tokens.js";
import { authStore, type AuthQueryable } from "./lib/authStore.js";
import { startShiftRepository, type StartShiftDatabase } from "./repositories/startShiftRepository.js";
import { identityRepository, type IdentityDatabase } from "./repositories/identityRepository.js";
import { refreshRepository, type RefreshDatabase } from "./repositories/refreshRepository.js";
import { registerShiftRoutes } from "./routes/shifts.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerWebAuthRoutes, WEB_AUTH_PREFIX } from "./routes/webAuth.js";
import { refreshCookiePolicy } from "./lib/refreshCookie.js";
import { mailTransportFor, type Mailer } from "./lib/mailer.js";
import { registerDevEmailRoutes } from "./routes/devEmail.js";
import { registerSesNotificationRoutes } from "./routes/sesNotifications.js";
import { emailDeliveryRepository, type EmailDeliveryDatabase } from "./repositories/emailDeliveryRepository.js";
import { trackedMailer } from "./lib/emailDelivery.js";
import { emailCorrectionRepository, type EmailCorrectionDatabase } from "./repositories/emailCorrectionRepository.js";
import { registerEmailCorrectionRoutes } from "./routes/emailCorrection.js";
import { fetchSnsText, type SnsFetch } from "./lib/sesNotifications.js";
import { backgroundWork } from "./lib/backgroundWork.js";
import { accountTokenRepository, type AccountTokenDatabase } from "./repositories/accountTokenRepository.js";
import { registerEmailVerificationRoutes } from "./routes/emailVerification.js";
import { passwordRepository, type PasswordDatabase } from "./repositories/passwordRepository.js";
import { registerPasswordRoutes } from "./routes/password.js";
import { driverInvitationRepository, type DriverInvitationDatabase } from "./repositories/driverInvitationRepository.js";
import { registerCompanyDriverRoutes } from "./routes/companyDrivers.js";
import { authRateLimits, EMAILS_PER_ADDRESS_PER_HOUR } from "./lib/authRateLimits.js";
import { sendThrottle } from "./lib/sendThrottle.js";

/**
 * Only the surface the app actually uses today. Structural rather than a Pick of
 * PrismaClient, so a test can build the app without a database — and so widening
 * it later is a deliberate act. PrismaClient satisfies this.
 *
 * The two identity reads arrive through AuthQueryable, which names them
 * individually. They are handed to `authStore` here and never travel further:
 * requireAuth receives the narrow AuthStore, not this type.
 *
 * An INTERSECTION rather than an interface extending all three: the same
 * delegate legitimately appears in more than one of them (`user` is read by
 * Start Shift and written by the account boundary), and an interface may not
 * extend two parents that describe one property differently. Intersecting
 * keeps every contributor's requirements simultaneously in force instead of
 * making one of them win.
 */
export type AppDatabase = AuthQueryable & StartShiftDatabase & IdentityDatabase & RefreshDatabase & AccountTokenDatabase & PasswordDatabase & EmailDeliveryDatabase & EmailCorrectionDatabase & DriverInvitationDatabase & {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
};

/**
 * What a caller may supply instead of the environment's choice. Only tests
 * use it — to read the account emails the app sends — and production passes
 * nothing, so its mailer is always `mailTransportFor(env)`'s.
 */
export interface AppOptions {
  mailer?: Mailer;
  /**
   * Where the development outbox writes, instead of `api/.mail-outbox/` —
   * tests only, so a development-mode test never writes into the developer's
   * own outbox. Has no effect unless the transport IS the outbox.
   */
  outboxDirectory?: string;
  /** Reads SNS certificates and subscription URLs — tests only, so none reaches the network. */
  snsFetch?: SnsFetch;
  /** Where a client's address comes from, instead of CLIENT_IP_SOURCE — tests only. */
  clientIpSource?: ClientIpSource;
}

/** The one 429 every limit answers with (F-05): a fixed, safe message. */
function rateLimited(): AppError {
  return new AppError(429, "Too many requests, try again shortly", "RATE_LIMITED");
}

export async function buildApp(prisma: AppDatabase, options: AppOptions = {}): Promise<FastifyInstance> {
  // Who a request is from, for every rate limit (F-15). Fastify's own
  // `trustProxy` stays OFF: request.ip is always the socket peer.
  const clientAddress = clientAddressOf(options.clientIpSource ?? env.CLIENT_IP_SOURCE);
  const app = Fastify({
    logger: env.NODE_ENV === "development" ? { transport: undefined, level: "info" } : true,
  });

  // On EVERY response — success, preflight, 401, 404, 429, 500 — so it is
  // the FIRST hook, ahead of cors and the rate limit, which can end a
  // request early. HSTS: the API is HTTPS-only behind Railway's edge, and a
  // browser that has seen this never downgrades a later request to http
  // (browsers ignore it over plain http, so local development is
  // unaffected). nosniff: every body is JSON or empty, and must never be
  // reinterpreted as script or HTML.
  app.addHook("onRequest", async (_request, reply) => {
    void reply.header("strict-transport-security", "max-age=63072000");
    void reply.header("x-content-type-options", "nosniff");
  });

  // Account emails (B4, B7). The mailer is chosen here, when the app is
  // built — never at import time — and work a request starts but does not
  // await is settled before the app finishes closing.
  const work = backgroundWork(app.log);
  app.addHook("onClose", async () => { await work.settled(); });
  const HOUR_MS = 60 * 60 * 1000;
  // An injected mailer (tests) is never the development outbox.
  const transport = options.mailer === undefined
    ? mailTransportFor(env, options.outboxDirectory)
    : { mailer: options.mailer, outbox: null };
  // Every transport — an injected one too — goes through delivery tracking
  // (D56): a suppressed address is not asked again, and what SES accepts is
  // recorded against its account.
  const delivery = emailDeliveryRepository(prisma);
  const mail = {
    mailer:    trackedMailer(transport.mailer, delivery, app.log),
    webAppUrl: webAppUrl(env),
    log:       app.log,
    throttles: {
      email_verification: sendThrottle({ max: EMAILS_PER_ADDRESS_PER_HOUR, windowMs: HOUR_MS }),
      password_reset:     sendThrottle({ max: EMAILS_PER_ADDRESS_PER_HOUR, windowMs: HOUR_MS }),
    },
  };
  const tokens = accountTokenRepository(prisma);

  // An explicit, normalised allowlist — never `origin: true`, which reflects
  // whatever Origin the caller sent and lets any site read the response. The
  // same list is the Origin guard's on the cookie routes (D45).
  //
  // `credentials` is decided PER REQUEST, and is true ONLY on the browser's
  // cookie-transport routes (`/auth/web/*`), which cannot work without it.
  // Everywhere else authority travels in an Authorization header (AUTH.md),
  // so the rest of the API stays uncredentialed — it is not converted to
  // cookie authentication.
  //
  // Both conditions, because the plugin would otherwise emit
  // `Access-Control-Allow-Credentials` even to an origin it refuses; a
  // browser would still block that response, but the grant should not be
  // made at all.
  const origins = allowedOrigins(env);
  await app.register(cors, {
    delegator: (request, callback) => {
      const origin = request.headers.origin;
      const credentialed = request.url.startsWith(WEB_AUTH_PREFIX)
        && typeof origin === "string" && origins.includes(origin);
      callback(null, { origin: origins, credentials: credentialed });
    },
  });

  // AUTH.md's tokens. `algorithms` is pinned so an `alg: none` or
  // algorithm-confusion token cannot verify, and iss/aud make a LogisticBay
  // TMS token structurally unusable here (D1). The secret is the one already
  // validated by env.schema.ts -- there is no second source.
  //
  // `requiredClaims` is not optional hardening: allowedIss/allowedAud are
  // VALUE validators that skip a claim which is absent, and expiry is only
  // checked when `exp` exists. Without this, a token simply omitting exp/iss/
  // aud verifies -- an unexpiring, cross-product-usable token. Presence of the
  // registered claims is enforced there; the identity claims (sub, companyId,
  // membershipId, sessionId) are enforced by the schemas in lib/auth.ts, so
  // each claim is decided in exactly one place.
  //
  // Registered ONCE, with the TENANT option set as the default (D21). The
  // identity pipeline passes its own COMPLETE option set to `verify` per call
  // (lib/tokens.ts), which @fastify/jwt builds a fresh verifier from -- so the
  // two audiences never share a verifier, and neither kind can be reached by
  // omitting an option. Signing is enabled by the secret being a plain string;
  // each token kind states its own sign options at the mint site.
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    verify: TENANT_VERIFY_OPTIONS,
  });

  // Built once, from the two named delegates. This is the only object the
  // authentication boundary can read through.
  const identity = authStore(prisma);

  // The global limit runs BEFORE authentication (F-15), so a client over its
  // limit is refused before any Session or membership is read: a flood costs
  // a counter, not the database.
  //
  // The plugin's own `global` mode cannot do that: it attaches a ROUTE-level
  // hook, and route-level hooks run after every app-level one — a request
  // that failed authentication was never even counted. Nor can an app-level
  // `app.rateLimit(...)` hook: the plugin lets only the FIRST of its limiters
  // count a request, so it would silently disable the endpoint limits (B6).
  // `createRateLimit` only answers "over the limit?" with its own store, so
  // it is checked here, first after cors (which answers a preflight itself),
  // and the endpoint limits still count. Per CLIENT, as `clientAddress`
  // decides it (lib/clientAddress.ts).
  await app.register(rateLimit, {
    global: false,
    keyGenerator: clientAddress,
    // Route rate-limit rejections through the app's own envelope with a
    // fixed, safe message -- not the plugin's default body, and not the
    // generic 4xx-passthrough this replaces (F-05).
    errorResponseBuilder: () => rateLimited(),
  });
  const globalLimit = app.createRateLimit({ max: 300, timeWindow: "1 minute", keyGenerator: clientAddress });
  app.addHook("onRequest", async (request, reply) => {
    const verdict = await globalLimit(request);
    if (verdict.isAllowed) return;
    // The standard headers, as the plugin's own limiter sends them — and how
    // the client-address source is verified against the live edge
    // (DEPLOYMENT.md): a forged X-Real-IP must not reset `remaining`.
    void reply.header("x-ratelimit-limit", String(verdict.max));
    void reply.header("x-ratelimit-remaining", String(verdict.remaining));
    void reply.header("x-ratelimit-reset", String(verdict.ttlInSeconds));
    if (!verdict.isExceeded) return;
    void reply.header("retry-after", String(verdict.ttlInSeconds));
    throw rateLimited();
  });

  // F-10, extended to three postures by D21: every route is TENANT-
  // authenticated by default. A route becomes public or identity-scoped only
  // through the explicit `config: { authPosture }` marker below -- never by
  // omission, and never by living outside some protected structure.
  // Registered on the root instance before any route, so Fastify's
  // encapsulation model applies it to every route added afterwards --
  // including ones later split into their own plugin files -- with no
  // registration path that skips it.
  //
  // Placed AFTER `cors`: a CORS preflight carries no Authorization header by
  // design, and cors's own onRequest hook already replies to OPTIONS and ends
  // the hook chain before this one runs, so preflight is never blocked here.
  // Placed AFTER the global rate limit (F-15): authentication reads the
  // database, and a client over its limit must not get that far.
  app.addHook("onRequest", async (request) => {
    if (request.is404) return; // no route matched -- let 404 handling run

    // Three postures (D21), and the polarity is unchanged from F-10: only an
    // EXACT match relaxes anything. `"tenant"`, an omitted marker, a typo, a
    // non-string, or future metadata this switch has never seen all fall
    // through to the tenant branch -- the strictest one. There is no default
    // that produces a public or identity-scoped route, so adding a third
    // posture did not add a way to become public by accident.
    const posture = request.routeOptions.config.authPosture;
    if (posture === "public") return;
    if (posture === "identity") {
      await requireSession(request, identity);
      return;
    }
    await requireAuth(request, identity);
  });

  // Every error path — thrown, validation, unknown route, crash — leaves
  // through the one envelope. Without this, Fastify's defaults return their
  // own shape and a 500 echoes the exception message to the client.
  registerErrorHandling(app);

  // B6's endpoint-specific limits — one shared hook per policy, built once
  // the plugin above has decorated the instance.
  const limits = authRateLimits(app, clientAddress);

  // The first protected business routes. Registered AFTER the default-deny
  // hook above, so they inherit it; the explicit `authPosture: "tenant"`
  // inside the route file states the posture where it is read. The repository
  // is built here, from the same database object, so a route never sees Prisma.
  registerShiftRoutes(app, startShiftRepository(prisma));

  // The account routes — the whole authentication lifecycle. Registered
  // after the default-deny hook, so every posture is applied by it and not by
  // anything inside the route file. TWO repositories, deliberately separate:
  // `identityRepository` owns User/Session creation and membership reads,
  // `refreshRepository` owns credential resolution and rotation and is the
  // narrow surface that makes F-21's ambiguous lookup unexpressible.
  registerAuthRoutes(app, identityRepository(prisma), refreshRepository(prisma), limits, delivery);

  // The BROWSER transport for the same lifecycle (D45, D46): the same
  // services and repositories, the refresh credential in an HttpOnly cookie,
  // every route behind the Origin guard its own scope registers.
  await registerWebAuthRoutes(
    app,
    identityRepository(prisma),
    refreshRepository(prisma),
    refreshCookiePolicy(env.NODE_ENV),
    origins,
    tokens,
    mail,
    work,
    limits,
  );

  // Email-ownership verification (B4): identity-posture resend, public
  // confirm. The token, not a header, authenticates the confirm.
  registerEmailVerificationRoutes(app, identityRepository(prisma), tokens, mail, limits);

  // DEVELOPMENT ONLY: the link the development outbox received, for the
  // account it was sent to. Registered only when the outbox IS the transport
  // (development, no provider key) — in production the route does not exist.
  if (transport.outbox !== null) registerDevEmailRoutes(app, identityRepository(prisma), tokens, transport.outbox);

  // SES bounces and complaints, from the ONE configured SNS topic (D55).
  // Absent unless a topic is configured: there is nothing to receive.
  if (env.SES_NOTIFICATION_TOPIC_ARN !== "") {
    registerSesNotificationRoutes(app, env.SES_NOTIFICATION_TOPIC_ARN, options.snsFetch ?? fetchSnsText, delivery);
  }

  // Password recovery and change (B7). Reset revokes every session; change
  // revokes every session but the caller's.
  registerPasswordRoutes(app, identityRepository(prisma), tokens, passwordRepository(prisma), mail, work, limits);

  // Correcting an address that cannot receive mail (D56).
  registerEmailCorrectionRoutes(app, {
    accounts:    identityRepository(prisma),
    passwords:   passwordRepository(prisma),
    delivery,
    corrections: emailCorrectionRepository(prisma),
    tokens,
    mail,
  }, limits);

  // A company adds its drivers (D63, stage 1). Tenant posture; the service
  // applies the company-admin gate (D54). The invitation email goes through
  // the same tracked mailer — so a suppressed address is not asked — but is
  // recorded on the invitation, never as an account's email (D56).
  registerCompanyDriverRoutes(app, driverInvitationRepository(prisma), {
    mailer:     mail.mailer,
    work,
    websiteUrl: mail.webAppUrl,
    log:        app.log,
  });

  // LIVENESS: the process is up and answering. Touches nothing else, so a
  // database outage never makes a supervisor restart a healthy process.
  app.get("/health/live", { config: { authPosture: "public" } }, (_request, reply) => reply.send({
    status:  "ok",
    service: "lb-timesheet-api",
    time:    new Date().toISOString(),
  }));

  // READINESS: the process can serve — its database answers. 503 when it
  // does not, so the outage is VISIBLE to a deploy gate or a monitor; the
  // process keeps running and recovers by itself when the database returns.
  app.get("/health", { config: { authPosture: "public" } }, async (_request, reply) => {
    const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    return reply.status(dbOk ? 200 : 503).send({
      status:  dbOk ? "ok" : "degraded",
      service: "lb-timesheet-api",
      db:      dbOk ? "up" : "down",
      time:    new Date().toISOString(),
    });
  });

  return app;
}
