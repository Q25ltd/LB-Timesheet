/**
 * Transactional email (B4, B7; Amazon SES — D55).
 *
 * One interface, three transports, chosen ONCE by `mailTransportFor` when the
 * app is built — never at import time, so no provider credential is read or
 * a client created merely because a module was loaded. The choice is the
 * EXPLICIT `MAIL_TRANSPORT` setting, never inferred from which keys happen to
 * be present, so live sending is never switched on by accident:
 *
 *   ses       Amazon SES (us-east-1). Production REQUIRES it: the
 *             environment schema refuses to boot production with anything
 *             else, or without SES credentials (F-07).
 *   outbox    development only: each message is written as JSON under
 *             `api/.mail-outbox/` (gitignored) for the developer, or a
 *             browser test, to open. The schema refuses it anywhere else.
 *   disabled  every send THROWS. The test default; tests that send mail
 *             inject their own, so one that sends by accident fails loudly
 *             rather than mailing nobody.
 *
 * There is no fallback recipient anywhere: a message goes to the address it
 * names, or it fails. Who it is FROM is not free text: each message names one
 * of the fixed senders below.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { MailTransportName } from "./env.schema.js";

/**
 * The sender addresses (owner decision, 2026-10-08) — one per kind of mail,
 * all on the SES-verified `logisticbay.com`. The IAM user that sends is
 * allowed these three From addresses and no others.
 *
 *   accounts    registration and email verification
 *   security    password resets and other security notices
 *   timesheets  timesheet reports — no such email is built yet (F-16)
 */
export const MAIL_SENDERS = {
  accounts:   "accounts@logisticbay.com",
  security:   "security@logisticbay.com",
  timesheets: "timesheets@logisticbay.com",
} as const;

type MailSender = keyof typeof MAIL_SENDERS;

/** Where a reply to ANY of them goes — the senders are not read. */
export const MAIL_REPLY_TO = "support@logisticbay.com";

export interface MailMessage {
  sender: MailSender;
  /** The account the email is for — what a later bounce or complaint is recorded against (D56). */
  userId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** Sends, and answers the provider's message id — or null where nothing was sent to a provider. */
  send(message: MailMessage): Promise<string | null>;
}

/** The one SES call the mailer makes — a seam for tests, satisfied by SESv2Client. */
export interface SesSend {
  send(command: SendEmailCommand): Promise<{ MessageId?: string | undefined }>;
}

/**
 * An SES failure, with nothing of the message in it. SES error messages can
 * name the recipient ("…failed the check: someone@example.com"), and a failed
 * send is logged — so only the AWS error NAME and HTTP status travel on.
 */
class MailDeliveryError extends Error {
  constructor(name: string, status: number | undefined) {
    super(`SES send failed: ${name}${status === undefined ? "" : ` (HTTP ${String(status)})`}`);
    this.name = "MailDeliveryError";
  }
}

function deliveryError(error: unknown): MailDeliveryError {
  if (!(error instanceof Error)) return new MailDeliveryError("UnknownError", undefined);
  const metadata: unknown = Reflect.get(error, "$metadata");
  const status: unknown = typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "httpStatusCode") : undefined;
  return new MailDeliveryError(error.name, typeof status === "number" ? status : undefined);
}

/** Amazon SES (API v2). One recipient per message — never a list, never a BCC. */
export function sesMailer(client: SesSend): Mailer {
  return {
    async send(message) {
      const command = new SendEmailCommand({
        FromEmailAddress: MAIL_SENDERS[message.sender],
        ReplyToAddresses: [MAIL_REPLY_TO],
        Destination:      { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              Html: { Data: message.html, Charset: "UTF-8" },
            },
          },
        },
      });
      let result: { MessageId?: string | undefined };
      try {
        result = await client.send(command);
      } catch (error) {
        throw deliveryError(error);
      }
      return result.MessageId ?? null;
    },
  };
}

/** Development only: `api/.mail-outbox/<time>-<id>.json`. */
const OUTBOX_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../.mail-outbox");

/**
 * The mailer, and — ONLY when it is the development outbox — the directory it
 * writes to. `outbox` is what makes the development email link route exist
 * (`routes/devEmail.ts`): it is a string in exactly one case, the `outbox`
 * transport, which the environment schema allows in development only.
 */
export interface MailTransport {
  mailer: Mailer;
  outbox: string | null;
}

interface MailEnv {
  MAIL_TRANSPORT: MailTransportName;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

export function mailTransportFor(env: MailEnv, outboxDirectory: string = OUTBOX_DIRECTORY): MailTransport {
  switch (env.MAIL_TRANSPORT) {
    case "ses": {
      const client = new SESv2Client({
        region: env.AWS_REGION,
        credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
      });
      return { mailer: sesMailer({ send: command => client.send(command) }), outbox: null };
    }
    case "outbox":
      return { mailer: directoryMailer(outboxDirectory), outbox: outboxDirectory };
    case "disabled":
      return { mailer: disabledMailer(), outbox: null };
  }
}

function directoryMailer(directory: string): Mailer {
  return {
    async send(message) {
      await mkdir(directory, { recursive: true });
      // Written as SES would send it: the resolved From and Reply-To included.
      const written = { from: MAIL_SENDERS[message.sender], replyTo: MAIL_REPLY_TO, ...message };
      await writeFile(resolve(directory, `${String(Date.now())}-${randomUUID()}.json`), JSON.stringify(written, null, 2));
      return null;
    },
  };
}

function disabledMailer(): Mailer {
  return {
    send() {
      return Promise.reject(new Error("email is disabled in this environment (MAIL_TRANSPORT=disabled)"));
    },
  };
}
