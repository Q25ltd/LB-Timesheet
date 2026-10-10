/**
 * Delivery status in the send path (D56): an address SES will not deliver
 * to is not asked again, and every email SES accepts is recorded against the
 * account it was for — so a later bounce or complaint names that account.
 *
 * Wraps whichever transport the app was built with. The development outbox
 * and the disabled transport return no message id, so nothing is recorded
 * for them; the suppression check applies to all three alike.
 */
import type { EmailSuppressionReason } from "../generated/enums.js";
import type { EmailDeliveryRepository } from "../repositories/emailDeliveryRepository.js";
import type { Mailer } from "./mailer.js";

/**
 * The recipient is on the suppression list. Carries no address: it is
 * logged when a background send meets it.
 */
export class RecipientSuppressedError extends Error {
  constructor() {
    super("email not sent: the recipient address is suppressed after a hard bounce or complaint");
    this.name = "RecipientSuppressedError";
  }
}

export interface DeliveryLog {
  error(details: object, message: string): void;
}

export function trackedMailer(inner: Mailer, delivery: EmailDeliveryRepository, log: DeliveryLog): Mailer {
  return {
    async send(message) {
      if ((await delivery.suppressionReasons(message.to)).length > 0) throw new RecipientSuppressedError();
      const sesMessageId = await inner.send(message);
      if (sesMessageId === null) return null;
      // Not an account's email (D63): its sender records it where it belongs.
      if (message.userId === null) return sesMessageId;
      try {
        await delivery.recordSent({ sesMessageId, userId: message.userId, sender: message.sender });
      } catch (error) {
        // The email WAS sent; failing the request now would tell its owner
        // otherwise. A bounce for it cannot be attributed, so it records
        // nothing (D58): SNS retries it and then drops it.
        log.error({ err: error, sesMessageId }, "a sent email could not be recorded");
      }
      return sesMessageId;
    },
  };
}

/** The account's own delivery problem, worst first — what it is shown and may correct. */
export function deliveryProblem(reasons: EmailSuppressionReason[]): EmailSuppressionReason | null {
  if (reasons.includes("hard_bounce")) return "hard_bounce";
  if (reasons.includes("complaint")) return "complaint";
  return null;
}
