/**
 * Company creation (owner decision B3).
 *
 *   POST /companies   identity — a verified account creates a company and
 *                     its own admin membership
 *
 * Identity, not tenant: there is no company yet to be scoped to, and it is the
 * ACCOUNT that is acting. A tenant token is the wrong kind here and is refused
 * by the identity verifier (D21).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityContext } from "../lib/auth.js";
import { invalidRequest } from "../lib/requestValidation.js";
import type { CompanyRepository } from "../repositories/companyRepository.js";
import type { IdentityRepository } from "../repositories/identityRepository.js";
import { CreateCompanyBody, createCompany } from "../services/companyCreation.js";

/** See `routes/auth.ts`: an identity route reached without its context is a wiring defect. */
function identified(identity: IdentityContext | undefined): IdentityContext {
  if (identity === undefined) throw new Error("identity route reached with no IdentityContext");
  return identity;
}

export function registerCompanyRoutes(
  app: FastifyInstance,
  accounts: IdentityRepository,
  companies: CompanyRepository,
): void {
  app.post(
    "/companies",
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateCompanyBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      const result = await createCompany(parsed.data, identified(request.identity).userId, accounts, companies);
      return reply.status(201).send(result);
    },
  );
}
