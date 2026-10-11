/**
 * The driver's own timesheet work with a company (D66) — identity posture,
 * through `authorizeTimesheetSubmission` (AUTH.md "Driver timesheet
 * submission"), never a tenant token:
 *
 *   POST /driver/shift-receipts   a start receipt for an ACTIVE membership
 *   POST /driver/timesheets       submit a timesheet (revision 1) — verified,
 *                                 or pending the company's review
 *
 * Routes only parse, and hand the parsed input on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityContext } from "../lib/auth.js";
import { invalidRequest } from "../lib/requestValidation.js";
import type { SubmissionMembershipLookup } from "../lib/submissionAuthorization.js";
import type { StartReceiptRepository } from "../repositories/startReceiptRepository.js";
import type { TimesheetSubmissionRepository } from "../repositories/timesheetSubmissionRepository.js";
import { StartReceiptBody, recordStartReceipt } from "../services/startReceipts.js";
import { SubmitTimesheetBody, submitTimesheet } from "../services/timesheetSubmissions.js";

/** A whole day's snapshot is a few tens of KB; this refuses anything no day could be. */
const SUBMISSION_BODY_LIMIT = 512 * 1024;

/** An identity route reached without its context is a wiring defect. */
function identified(identity: IdentityContext | undefined): IdentityContext {
  if (identity === undefined) throw new Error("identity route reached with no IdentityContext");
  return identity;
}

export function registerDriverTimesheetRoutes(
  app: FastifyInstance,
  memberships: SubmissionMembershipLookup,
  receipts: StartReceiptRepository,
  submissions: TimesheetSubmissionRepository,
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

  app.post(
    "/driver/timesheets",
    { config: { authPosture: "identity" }, bodyLimit: SUBMISSION_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SubmitTimesheetBody.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      const result = await submitTimesheet(identified(request.identity), parsed.data, memberships, submissions);
      // 201 for a timesheet stored now, 200 for a replay of one already stored.
      return reply.status(result.created ? 201 : 200).send({ timesheet: result.timesheet });
    },
  );
}
