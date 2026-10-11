/**
 * A company's settings (D66) — the company website's routes:
 *
 *   GET  /company/settings/units                 tenant — the company's units, or null where none is chosen
 *   PUT  /company/settings/units                 tenant — choose or change both
 *   GET  /company/settings/report-email          tenant — the report address and whether it is confirmed
 *   PUT  /company/settings/report-email          tenant — set or change it; a confirmation link is sent
 *   POST /company/settings/report-email/confirm  public — the emailed token is the credential
 *
 * Tenant posture under the default-deny hook; the SERVICE applies D54's
 * company-admin gate. The company is the token's; the body carries the units
 * and nothing else.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthContext } from "../lib/auth.js";
import { invalidRequest } from "../lib/requestValidation.js";
import type { CompanySettingsRepository } from "../repositories/companySettingsRepository.js";
import type { ReportEmailRepository } from "../repositories/reportEmailRepository.js";
import { UnitsBody, companyUnits, setCompanyUnits } from "../services/companySettings.js";
import {
  ConfirmReportEmailBody,
  ReportEmailBody,
  confirmReportEmail,
  readReportEmail,
  setReportEmail,
  type ReportEmailMail,
} from "../services/companyReportEmail.js";

const UNITS = "/company/settings/units";
const REPORT_EMAIL = "/company/settings/report-email";

/** A protected route reached without an AuthContext is a wiring defect, not a client error. */
function authenticated(auth: AuthContext | undefined): AuthContext {
  if (auth === undefined) throw new Error("protected route reached with no AuthContext");
  return auth;
}

export function registerCompanySettingsRoutes(
  app: FastifyInstance,
  settings: CompanySettingsRepository,
  reports: ReportEmailRepository,
  mail: ReportEmailMail,
): void {
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

  app.get(
    REPORT_EMAIL,
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest) => ({ reportEmail: await readReportEmail(authenticated(request.auth), reports) }),
  );

  app.put(
    REPORT_EMAIL,
    { config: { authPosture: "tenant" } },
    async (request: FastifyRequest) => {
      const parsed = ReportEmailBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      return { reportEmail: await setReportEmail(authenticated(request.auth), parsed.data, reports, mail) };
    },
  );

  // Public: the token in the emailed link proves the mailbox, and does
  // nothing but confirm the one address it was sent to.
  app.post(
    `${REPORT_EMAIL}/confirm`,
    { config: { authPosture: "public" } },
    async (request: FastifyRequest) => {
      const parsed = ConfirmReportEmailBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      return confirmReportEmail(parsed.data.token, reports);
    },
  );
}
