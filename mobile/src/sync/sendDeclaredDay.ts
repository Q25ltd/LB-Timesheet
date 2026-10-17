/**
 * After a company's day is saved with its declaration: queue it to send (D66
 * stage S6) and say only what is true of the result. `null` when there is
 * nothing to send — sending is off (until S8), or it is a Personal day — and
 * the caller says, as before, that nothing was sent.
 */
import { effectiveFacts, type CompletedShift } from "../shift/localShift";
import type { AccountScope } from "../shift/accountScope";
import { requestSync } from "./SyncDriver";
import { queueTimesheet } from "./submissionQueue";

export interface SendNotice {
  message: string;
  /** Whether the day is now queued to send — and locked. */
  queued: boolean;
}

export async function sendDeclaredDay(scope: AccountScope, day: CompletedShift): Promise<SendNotice | null> {
  const facts = effectiveFacts(day);
  const company = facts.workingFor.kind === "company" ? facts.workingFor.companyName : null;
  if (company === null) return null;

  const outcome = await queueTimesheet(scope, day.id);
  switch (outcome.kind) {
    case "queued":
      requestSync();
      return { message: `Saved, and queued to send to ${company}. It is sent as soon as there is a connection.`, queued: true };
    case "needs-correction":
      return { message: `Saved on this phone, but not sent to ${company}: ${outcome.problems.join(" ")}`, queued: false };
    case "failed":
      return { message: `Saved on this phone, but it could not be queued to send to ${company}. Open the timesheet to send it.`, queued: false };
    case "locked":
      return { message: `This timesheet is already on its way to ${company}.`, queued: true };
    case "disabled":
    case "missing":
    case "personal":
    case "undeclared":
      return null;
  }
}
