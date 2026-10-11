/**
 * The driver's own timesheet work with a company (D66) — identity posture,
 * through `authorizeTimesheetSubmission` (AUTH.md "Driver timesheet
 * submission"), never a tenant token:
 *
 *   POST /driver/shift-receipts   a start receipt for an ACTIVE membership
 *
 * Routes only parse, and hand the parsed input on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityContext } from "../lib/auth.js";
import { invalidRequest } from "../lib/requestValidation.js";
import type { SubmissionMembershipLookup } from "../lib/submissionAuthorization.js";
import type { StartReceiptRepository } from "../repositories/startReceiptRepository.js";
import { StartReceiptBody, recordStartReceipt } from "../services/startReceipts.js";

/** An identity route reached without its context is a wiring defect. */
function identified(identity: IdentityContext | undefined): IdentityContext {
  if (identity === undefined) throw new Error("identity route reached with no IdentityContext");
  return identity;
}

export function registerDriverTimesheetRoutes(
  app: FastifyInstance,
  memberships: SubmissionMembershipLookup,
  receipts: StartReceiptRepository,
): void {
  app.post(
    "/driver/shift-receipts",
    { config: { authPosture: "identity" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = StartReceiptBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      const result = await recordStartReceipt(identified(request.identity), parsed.data, memberships, receipts);
      // 201 for a receipt kept now, 200 for a replay — so the phone can tell them apart.
      return reply.status(result.created ? 201 : 200).send({ receipt: result.receipt });
    },
  );
}
