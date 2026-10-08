import { z } from "zod";

/**
 * Origins allowed when running development or test WITHOUT an explicit
 * WEB_ORIGIN. Stated here rather than implied — there is no implicit fallback
 * anywhere else in the CORS path.
 */
export const DEV_ORIGINS = [
  "http://localhost:5173", // Vite dev server (web app)
  "http://localhost:4173", // Vite preview
] as const;

const NODE_ENVS = ["development", "test", "production"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/**
 * How email leaves this process (lib/mailer.ts). Explicit, never inferred from
 * which keys are present, so live sending is never switched on by accident.
 */
const MAIL_TRANSPORTS = ["ses", "outbox", "disabled"] as const;
export type MailTransportName = (typeof MAIL_TRANSPORTS)[number];

/** The transport an UNSET MAIL_TRANSPORT means. Production has none: it must say `ses`. */
function defaultMailTransport(nodeEnv: NodeEnv | undefined): MailTransportName | null {
  if (nodeEnv === "development") return "outbox";
  if (nodeEnv === "test") return "disabled";
  return null;
}

/**
 * Where a request's client address comes from, for rate limiting (F-15,
 * lib/clientAddress.ts). Explicit in production: behind a proxy the wrong
 * choice puts every client in one bucket, or lets a client choose its own.
 */
const CLIENT_IP_SOURCES = ["socket", "x-real-ip"] as const;
export type ClientIpSource = (typeof CLIENT_IP_SOURCES)[number];

/** An AWS Region code, e.g. `us-east-1`. */
const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** An SNS topic ARN — where SES publishes bounces and complaints. */
const SNS_TOPIC_ARN_PATTERN = /^arn:aws:sns:[a-z]{2}(-[a-z]+)+-\d:\d{12}:[A-Za-z0-9_-]{1,256}$/;
/** An SES configuration set name: letters, digits, `_` and `-`, at most 64. */
const SES_CONFIGURATION_SET_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Only these two relax the CORS requirement. Note that NODE_ENV is OPTIONAL in
 * the schema: an unset NODE_ENV is NOT development. A deploy that forgets to set
 * it must fail closed, not inherit developer defaults.
 */
function isDevLike(nodeEnv: NodeEnv | undefined): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validate and NORMALISE one origin. Returns the canonical `scheme://host`
 * form, or null when the value cannot be used as a CORS origin.
 *
 * Rejects: "*", any host containing "*", non-https schemes (except http on
 * localhost when permitted), userinfo, and anything carrying a path, query,
 * fragment or trailing slash.
 *
 * Normalises case and the default port, so `https://A.Example.COM:443` becomes
 * `https://a.example.com` — which is what a browser actually sends in Origin.
 */
export function normaliseOrigin(
  raw: string,
  options: { allowInsecureLocalhost: boolean },
): string | null {
  const value = raw.trim();
  if (value === "" || value === "*" || value === "null") return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.hostname.includes("*")) return null;          // https://*.example.com
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (/\/$/.test(value) || value.split("//")[1]?.includes("/")) return null;

  const isLocalhost = LOCALHOST_HOSTS.has(url.hostname);
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && options.allowInsecureLocalhost && isLocalhost) return url.origin;
  return null;
}

/**
 * Values that mean "someone copied an example". Matched case-insensitively as
 * substrings and rejected in EVERY environment — a known signing secret means
 * every token is forgeable, and a placeholder that boots is a placeholder that
 * ships. No entropy scoring: these two checks (blocklist + distinct characters)
 * are dumb on purpose, because clever scoring rejects real secrets and gets
 * deleted. A rejected good secret costs a regeneration; an accepted bad one
 * costs the auth system.
 */
const JWT_PLACEHOLDER_FRAGMENTS = [
  "change-me", "changeme", "replace-me", "replaceme",
  "example", "placeholder", "password", "secret",
] as const;

const JWT_MIN_LENGTH = 32;            // dev/test floor (unchanged)
const JWT_MIN_LENGTH_PRODUCTION = 64; // e.g. `openssl rand -hex 32` = 64 chars = 32 bytes
const JWT_MIN_DISTINCT_CHARS = 10;    // rejects "xxxx…", "abab…", keyboard mashes

/** Why this secret is unusable, or null when it is acceptable. */
function jwtSecretProblem(rawSecret: string, isProductionLike: boolean): string | null {
  const secret = rawSecret.trim();
  const minLength = isProductionLike ? JWT_MIN_LENGTH_PRODUCTION : JWT_MIN_LENGTH;
  if (secret.length < minLength) {
    return `JWT_SECRET must be at least ${String(minLength)} characters` +
      (isProductionLike ? " in production (try: openssl rand -hex 32)" : "");
  }
  const lower = secret.toLowerCase();
  for (const fragment of JWT_PLACEHOLDER_FRAGMENTS) {
    if (lower.includes(fragment)) {
      return `JWT_SECRET looks like a placeholder (contains "${fragment}") — generate a real one: openssl rand -hex 32`;
    }
  }
  if (new Set(secret).size < JWT_MIN_DISTINCT_CHARS) {
    return "JWT_SECRET has too little variety (repeated characters) — generate a real one: openssl rand -hex 32";
  }
  return null;
}

const BaseEnv = z.object({
  DATABASE_URL:     z.string().min(1, "DATABASE_URL is required").max(500),
  JWT_SECRET:       z.string().min(1, "JWT_SECRET is required").max(500),
  /** ses | outbox | disabled — see MAIL_TRANSPORTS. Unset: development → outbox, test → disabled, production → refused. */
  MAIL_TRANSPORT:   z.enum(MAIL_TRANSPORTS).optional(),
  /** socket | x-real-ip — see CLIENT_IP_SOURCES. Unset: development and test → socket; production → refused. */
  CLIENT_IP_SOURCE: z.enum(CLIENT_IP_SOURCES).optional(),
  /** Where SES sends from: the region `logisticbay.com` is verified in (us-east-1). */
  AWS_REGION:       z.string().max(32).default("us-east-1"),
  /** The `lb-timesheets-ses` IAM user's key — required when MAIL_TRANSPORT is ses. */
  AWS_ACCESS_KEY_ID:     z.string().max(128).default(""),
  AWS_SECRET_ACCESS_KEY: z.string().max(128).default(""),
  /**
   * The SNS topic SES publishes bounces and complaints to. When set, the
   * signed-notification endpoint exists and accepts messages from THIS topic
   * only; when empty it is not registered.
   */
  SES_NOTIFICATION_TOPIC_ARN: z.string().max(400).default(""),
  /**
   * The SES configuration set EVERY send names (D58) — Timesheets' own, so
   * the bounces and complaints SES publishes for it are this product's mail
   * alone. Required when MAIL_TRANSPORT is ses.
   */
  SES_CONFIGURATION_SET: z.string().max(64).default(""),
  /** Comma-separated origins allowed to call this API. */
  WEB_ORIGIN:       z.string().max(2000).default(""),
  /**
   * The ONE web origin emailed links point at (verification, password reset).
   * Required outside dev/test, and must be one of the allowed origins.
   */
  WEB_APP_URL:      z.string().max(2000).default(""),
  PORT:             z.coerce.number().int().positive().max(65535).default(3000),
  /** Optional on purpose — see isDevLike. */
  NODE_ENV:         z.enum(NODE_ENVS).optional(),
});

export const EnvSchema = BaseEnv
  .superRefine((value, ctx) => {
    const devLike = isDevLike(value.NODE_ENV);

    // Same fail-closed posture as WEB_ORIGIN: anything not explicitly dev/test
    // gets the production rules. A deploy that forgets NODE_ENV must not get
    // the lenient floor.
    const secretProblem = jwtSecretProblem(value.JWT_SECRET, !devLike);
    if (secretProblem !== null) {
      ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: secretProblem });
    }

    // The entire product is "PDF arrives in an inbox" (PRODUCT.md), and an
    // account cannot be confirmed without its email. A production process
    // must never be UNCONFIGURED for email (F-07): it says which transport,
    // explicitly. Two are possible there:
    //   ses       real email — with its credentials, below
    //   disabled  a deliberate, controlled deployment that sends nothing (a
    //             private first deploy, D57); every send fails and is logged
    // An unset value is refused, so "no email" is never an accident.
    const transport = value.MAIL_TRANSPORT ?? defaultMailTransport(value.NODE_ENV);
    if (transport === null || (!devLike && transport !== "ses" && transport !== "disabled")) {
      ctx.addIssue({
        code: "custom",
        path: ["MAIL_TRANSPORT"],
        message: "MAIL_TRANSPORT must be set explicitly to \"ses\" (or \"disabled\" for a deployment that sends no email) unless NODE_ENV is explicitly development or test",
      });
    }
    if (value.CLIENT_IP_SOURCE === undefined && !devLike) {
      ctx.addIssue({
        code: "custom",
        path: ["CLIENT_IP_SOURCE"],
        message: "CLIENT_IP_SOURCE must be set explicitly unless NODE_ENV is explicitly development or test — \"x-real-ip\" behind Railway's edge, \"socket\" with no proxy in front",
      });
    }
    if (transport === "outbox" && value.NODE_ENV !== "development") {
      ctx.addIssue({
        code: "custom",
        path: ["MAIL_TRANSPORT"],
        message: "MAIL_TRANSPORT=outbox writes email to local files and is allowed only when NODE_ENV is development",
      });
    }
    if (transport === "ses") {
      for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const) {
        if (value[key].trim() === "") {
          ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when MAIL_TRANSPORT is ses` });
        }
      }
    }
    const configurationSet = value.SES_CONFIGURATION_SET.trim();
    if (transport === "ses" && configurationSet === "") {
      ctx.addIssue({ code: "custom", path: ["SES_CONFIGURATION_SET"], message: "SES_CONFIGURATION_SET is required when MAIL_TRANSPORT is ses" });
    } else if (configurationSet !== "" && !SES_CONFIGURATION_SET_PATTERN.test(configurationSet)) {
      ctx.addIssue({ code: "custom", path: ["SES_CONFIGURATION_SET"], message: "SES_CONFIGURATION_SET must be an SES configuration set name (letters, digits, _ and -; at most 64)" });
    }
    if (!AWS_REGION_PATTERN.test(value.AWS_REGION)) {
      ctx.addIssue({ code: "custom", path: ["AWS_REGION"], message: `"${value.AWS_REGION}" is not an AWS Region code (e.g. us-east-1)` });
    }
    const topic = value.SES_NOTIFICATION_TOPIC_ARN.trim();
    if (topic !== "" && !SNS_TOPIC_ARN_PATTERN.test(topic)) {
      ctx.addIssue({ code: "custom", path: ["SES_NOTIFICATION_TOPIC_ARN"], message: "SES_NOTIFICATION_TOPIC_ARN must be an SNS topic ARN (arn:aws:sns:<region>:<account>:<name>)" });
    }

    // An emailed link is a credential delivered to a person: it must point at
    // the product's own web app, never at a guess. Validated against the same
    // allowlist the API trusts, so a link can only ever name an origin the
    // Origin guard would also accept.
    const appUrl = value.WEB_APP_URL.trim();
    if (!devLike && appUrl === "") {
      ctx.addIssue({
        code: "custom",
        path: ["WEB_APP_URL"],
        message: "WEB_APP_URL is required unless NODE_ENV is explicitly development or test (the https web origin emailed links open)",
      });
    } else if (appUrl !== "") {
      const normalised = normaliseOrigin(appUrl, { allowInsecureLocalhost: devLike });
      if (normalised === null || normalised !== appUrl || !allowedOrigins(value).includes(normalised)) {
        ctx.addIssue({
          code: "custom",
          path: ["WEB_APP_URL"],
          message: `"${appUrl}" must be exactly one of the allowed web origins (WEB_ORIGIN)`,
        });
      }
    }

    const configured = splitOrigins(value.WEB_ORIGIN);

    if (!devLike && configured.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["WEB_ORIGIN"],
        message:
          "WEB_ORIGIN is required unless NODE_ENV is explicitly development or test " +
          "(comma-separated https origins)",
      });
      return;
    }

    for (const origin of configured) {
      if (normaliseOrigin(origin, { allowInsecureLocalhost: devLike }) === null) {
        ctx.addIssue({
          code: "custom",
          path: ["WEB_ORIGIN"],
          message:
            `"${origin}" is not a usable origin — expected scheme://host with no ` +
            `path, no trailing slash, no wildcard` +
            (devLike ? " (http allowed only on localhost)" : ", https only"),
        });
      }
    }
  })
  // Validation above treats an unset NODE_ENV as production-like; the runtime
  // value must agree, or the logger and every future env.NODE_ENV branch would
  // run in dev mode under production rules. Unset resolves to "production".
  .transform(value => ({
    ...value,
    NODE_ENV: value.NODE_ENV ?? "production",
    // Validation above has refused every case where this would be null.
    MAIL_TRANSPORT: value.MAIL_TRANSPORT ?? defaultMailTransport(value.NODE_ENV) ?? "disabled",
    SES_NOTIFICATION_TOPIC_ARN: value.SES_NOTIFICATION_TOPIC_ARN.trim(),
    SES_CONFIGURATION_SET: value.SES_CONFIGURATION_SET.trim(),
    // Validation above has refused an unset value outside development and test.
    CLIENT_IP_SOURCE: value.CLIENT_IP_SOURCE ?? "socket",
  }));

export type Env = z.infer<typeof EnvSchema>;

/** Split a comma-separated origin list, trimming blanks. */
export function splitOrigins(raw: string): string[] {
  return raw.split(",").map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * The effective CORS allowlist, normalised. Every entry goes through
 * normaliseOrigin here — validation does not live only in the schema, so this
 * function's guarantee holds however it is called.
 *
 * Never returns "*". Returns [] rather than anything permissive when misconfigured.
 */
export function allowedOrigins(env: { WEB_ORIGIN: string; NODE_ENV?: NodeEnv | undefined }): string[] {
  const devLike = isDevLike(env.NODE_ENV);
  const configured = splitOrigins(env.WEB_ORIGIN);
  const source = configured.length > 0 ? configured : devLike ? [...DEV_ORIGINS] : [];
  const normalised = source
    .map(origin => normaliseOrigin(origin, { allowInsecureLocalhost: devLike }))
    .filter((origin): origin is string => origin !== null);
  return [...new Set(normalised)];
}

/**
 * The web origin emailed links open. The configured value — already proven by
 * the schema to be one of the allowed origins — or, in development and test
 * only, the Vite dev server.
 */
export function webAppUrl(env: { WEB_APP_URL: string }): string {
  const configured = env.WEB_APP_URL.trim();
  return configured !== "" ? configured : DEV_ORIGINS[0];
}

/** Human-readable reason a set of environment values is unusable. */
export function describeEnvFailure(error: z.ZodError): string {
  return error.issues.map(i => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}
