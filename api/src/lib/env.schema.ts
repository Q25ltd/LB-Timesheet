import { z } from "zod";

/**
 * Pure environment validation — no side effects, no process.exit, safe to
 * import from a test. The loading and the exit-on-failure live in env.ts.
 */
export const EnvSchema = z.object({
  DATABASE_URL:     z.string().min(1, "DATABASE_URL is required").max(500),
  JWT_SECRET:       z.string().min(32, "JWT_SECRET must be at least 32 characters").max(500),
  SENDGRID_API_KEY: z.string().max(200).default(""),
  MAIL_FROM:        z.string().max(320).default("timesheets@logisticbay.com"),
  PORT:             z.coerce.number().int().positive().max(65535).default(3000),
  NODE_ENV:         z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

/** Human-readable reason a set of environment values is unusable. */
export function describeEnvFailure(error: z.ZodError): string {
  return error.issues.map(i => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}
