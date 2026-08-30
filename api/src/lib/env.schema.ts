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
  SENDGRID_API_KEY: z.string().max(200).default(""),
  MAIL_FROM:        z.string().max(320).default("timesheets@logisticbay.com"),
  /** Comma-separated origins allowed to call this API. */
  WEB_ORIGIN:       z.string().max(2000).default(""),
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

    // The entire product is "PDF arrives in an inbox" (PRODUCT.md). A
    // production process with email unconfigured would accept submissions it
    // can never deliver — so it must not start. Dev/test run without a key on
    // purpose (submissions log instead of send).
    if (!devLike) {
      if (value.SENDGRID_API_KEY.trim() === "") {
        ctx.addIssue({
          code: "custom",
          path: ["SENDGRID_API_KEY"],
          message: "SENDGRID_API_KEY is required unless NODE_ENV is explicitly development or test",
        });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.MAIL_FROM)) {
        ctx.addIssue({
          code: "custom",
          path: ["MAIL_FROM"],
          message: `MAIL_FROM must be a plain email address, got "${value.MAIL_FROM}"`,
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
  .transform(value => ({ ...value, NODE_ENV: value.NODE_ENV ?? "production" }));

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

/** Human-readable reason a set of environment values is unusable. */
export function describeEnvFailure(error: z.ZodError): string {
  return error.issues.map(i => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}
