/**
 * The driver's SUBMISSION authority (D66; AUTH.md "Driver timesheet
 * submission") — deliberately NOT a `TenantContext`.
 *
 * It names one membership of the signed-in driver — active, deactivated or
 * removed — and is accepted only by the submission and receipt repositories.
 * It grants: submit or amend this driver's own timesheet for this membership,
 * record a start receipt (active only), and read this driver's own
 * submissions. A `TenantContext` cannot be made from it, and it cannot be
 * made from a request: `trust` is called only by `authorizeTimesheetSubmission`
 * (`lib/submissionAuthorization.ts`), which loads the membership BY ITS ID
 * AND the signed-in user's id. check-rules enforces the call site.
 */
export class SubmissionContext {
  /** Nominal-typing brand: a TenantContext is not one, and this is not a TenantContext. */
  private readonly kind = "SubmissionContext";

  private constructor(
    /** The signed-in driver. */
    readonly userId: string,
    /** The driver's own membership the work is for. */
    readonly membershipId: string,
    /** That membership's company — from the ROW, never the request. */
    readonly companyId: string,
    /** Whether that membership is active NOW, as read on this request. */
    readonly membershipActive: boolean,
  ) {
    Object.freeze(this);
  }

  static trust(source: { userId: string; membershipId: string; companyId: string; membershipActive: boolean }): SubmissionContext {
    return new SubmissionContext(source.userId, source.membershipId, source.companyId, source.membershipActive);
  }

  /** For log lines; never exposed in a response. */
  describe(): string {
    return `${this.kind}(membership=${this.membershipId}, active=${String(this.membershipActive)})`;
  }
}
