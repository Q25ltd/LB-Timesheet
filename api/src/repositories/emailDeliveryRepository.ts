/**
 * Email delivery status (D56): what SES accepted, what it later reported, and
 * which addresses it will not deliver to.
 *
 * Account-level data — never tenant data. Nothing here takes or returns a
 * company, and no company-facing read exists: a company must not learn
 * anything about any account's mail, its own administrators' included,
 * through this.
 */
import type { EmailDeliveryEventKind, EmailSender, EmailSuppressionReason } from "../generated/enums.js";
import { prismaErrorCode, UNIQUE_VIOLATION_CODE } from "./identityRepository.js";

interface EmailDeliveryTransaction {
  emailMessage: {
    findUnique(args: { where: { sesMessageId: string } }): Promise<{ id: string } | null>;
  };
  emailDeliveryEvent: {
    create(args: {
      data: { feedbackId: string; kind: EmailDeliveryEventKind; detail: string | null; emailMessageId: string | null; occurredAt: Date };
    }): Promise<{ id: string }>;
  };
  emailSuppression: {
    upsert(args: {
      where: { email_reason: { email: string; reason: EmailSuppressionReason } };
      create: { email: string; reason: EmailSuppressionReason; recordedAt: Date };
      update: { recordedAt: Date };
    }): Promise<unknown>;
  };
}

export interface EmailDeliveryDatabase {
  emailSuppression: {
    findMany(args: { where: { email: string } }): Promise<{ reason: EmailSuppressionReason }[]>;
  };
  emailMessage: {
    create(args: { data: { sesMessageId: string; userId: string; sender: EmailSender } }): Promise<{ id: string }>;
  };
  emailDeliveryEvent: {
    findUnique(args: { where: { feedbackId: string } }): Promise<{ id: string } | null>;
  };
  $transaction<T>(fn: (tx: EmailDeliveryTransaction) => Promise<T>): Promise<T>;
}

/** One SES bounce or complaint, as the application records it. */
export interface DeliveryEventInput {
  feedbackId: string;
  kind: EmailDeliveryEventKind;
  detail: string | null;
  sesMessageId: string;
  occurredAt: Date;
  /** The addresses SES now suppresses because of it — empty for a transient bounce. */
  suppress: { email: string; reason: EmailSuppressionReason }[];
}

export function emailDeliveryRepository(db: EmailDeliveryDatabase) {
  /** The event and its suppressions, together or not at all. */
  async function write(input: DeliveryEventInput): Promise<void> {
    await db.$transaction(async tx => {
      const message = await tx.emailMessage.findUnique({ where: { sesMessageId: input.sesMessageId } });
      await tx.emailDeliveryEvent.create({
        data: {
          feedbackId:     input.feedbackId,
          kind:           input.kind,
          detail:         input.detail,
          emailMessageId: message?.id ?? null,
          occurredAt:     input.occurredAt,
        },
      });
      for (const { email, reason } of input.suppress) {
        await tx.emailSuppression.upsert({
          where:  { email_reason: { email, reason } },
          create: { email, reason, recordedAt: input.occurredAt },
          update: { recordedAt: input.occurredAt },
        });
      }
    });
  }

  return {
    /**
     * Why SES will not deliver to `email`, or [] when nothing is known. The
     * column is citext, so the address's case does not matter.
     */
    async suppressionReasons(email: string): Promise<EmailSuppressionReason[]> {
      const rows = await db.emailSuppression.findMany({ where: { email } });
      return rows.map(row => row.reason);
    },

    /** SES accepted an email for this account. */
    async recordSent(input: { sesMessageId: string; userId: string; sender: EmailSender }): Promise<void> {
      await db.emailMessage.create({ data: input });
    },

    /**
     * Record one bounce or complaint, ONCE. A redelivered notification (the
     * same SES feedback id) changes nothing and answers "duplicate".
     *
     * A unique violation is a duplicate only if THIS feedback id is already
     * recorded. Otherwise it was a concurrent suppression of the same address
     * racing this one (an upsert's insert), and one retry settles it.
     */
    async recordEvent(input: DeliveryEventInput): Promise<"recorded" | "duplicate"> {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await write(input);
          return "recorded";
        } catch (error) {
          if (prismaErrorCode(error) !== UNIQUE_VIOLATION_CODE) throw error;
          if (await db.emailDeliveryEvent.findUnique({ where: { feedbackId: input.feedbackId } }) !== null) return "duplicate";
          if (attempt === 2) throw error;
        }
      }
    },
  };
}

export type EmailDeliveryRepository = ReturnType<typeof emailDeliveryRepository>;
