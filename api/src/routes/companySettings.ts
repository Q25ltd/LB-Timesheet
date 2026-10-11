/**
 * A company's settings (D66) — the company website's routes:
 *
 *   GET /company/settings/units   tenant — the company's units, or null where none is chosen
 *   PUT /company/settings/units   tenant — choose or change both
 *
 * Tenant posture under the default-deny hook; the SERVICE applies D54's
 * company-admin gate. The company is the token's; the body carries the units
 * and nothing else.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthContext } from "../lib/auth.js";
import { invalidRequest } from "../lib/requestValidation.js";
import type { CompanySettingsRepository } from "../repositories/companySettingsRepository.js";
import { UnitsBody, companyUnits, setCompanyUnits } from "../services/companySettings.js";

const UNITS = "/company/settings/units";

/** A protected route reached without an AuthContext is a wiring defect, not a client error. */
function authenticated(auth: AuthContext | undefined): AuthContext {
  if (auth === undefined) throw new Error("protected route reached with no AuthContext");
  return auth;
}

export function registerCompanySettingsRoutes(app: FastifyInstance, settings: CompanySettingsRepository): void {
  app.get(
    UNITS,
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest) => ({ units: await companyUnits(authenticated(request.auth), settings) }),
  );

  app.put(
    UNITS,
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest) => {
      const parsed = UnitsBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      return { units: await setCompanyUnits(authenticated(request.auth), parsed.data, settings) };
    },
  );
}
