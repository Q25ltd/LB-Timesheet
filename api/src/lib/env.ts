import { EnvSchema, describeEnvFailure, type Env } from "./env.schema.js";

export type { Env } from "./env.schema.js";

/**
 * Reads and validates process.env once, at import. Exits with a readable
 * message rather than letting an undefined value surface later as a confusing
 * runtime failure. The schema itself lives in env.schema.ts so it can be tested
 * without this side effect — importing a module that may call process.exit is
 * not testable, which is how this split came about.
 */
function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      `\n❌  Invalid environment:\n${describeEnvFailure(parsed.error)}\n\n` +
      `Copy .env.example to .env and fill it in.\n`,
    );
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();

/** True when email is not configured — submissions log instead of sending. */
export const mailDisabled = env.SENDGRID_API_KEY.trim() === "";
