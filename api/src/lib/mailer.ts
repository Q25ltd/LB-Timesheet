/**
 * Transactional email — the minimum the account lifecycle needs (B4, B7).
 *
 * One interface, three implementations, chosen ONCE by `mailerFor` when the
 * app is built — never at import time, so no provider credential is read or
 * installed merely because a module was loaded:
 *
 *   SendGrid    whenever a key is configured. Production REQUIRES one: the
 *               environment schema refuses to boot without it (F-07), so a
 *               production process can never fall through to the others.
 *   directory   development without a key: each message is written as JSON
 *               under `api/.mail-outbox/` (gitignored) for the developer, or
 *               a browser test, to open. Never selected outside development.
 *   unconfigured  test without a key: every send THROWS. Tests that send mail
 *               inject their own; a test that sends by accident fails loudly
 *               rather than mailing nobody.
 *
 * There is no fallback recipient anywhere: a message goes to the address it
 * names, or it fails.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sendgrid from "@sendgrid/mail";
import type { NodeEnv } from "./env.schema.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

function sendGridMailer(apiKey: string, from: string): Mailer {
  // Configured HERE, when the app is built with a key — never by importing
  // this module.
  sendgrid.setApiKey(apiKey);
  return {
    async send(message) {
      await sendgrid.send({ to: message.to, from, subject: message.subject, text: message.text, html: message.html });
    },
  };
}

/** Development only: `api/.mail-outbox/<time>-<id>.json`. */
const OUTBOX_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../.mail-outbox");

function directoryMailer(directory: string): Mailer {
  return {
    async send(message) {
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, `${String(Date.now())}-${randomUUID()}.json`), JSON.stringify(message, null, 2));
    },
  };
}

function unconfiguredMailer(): Mailer {
  return {
    send() {
      return Promise.reject(new Error("email is not configured in this environment"));
    },
  };
}

export function mailerFor(env: { SENDGRID_API_KEY: string; MAIL_FROM: string; NODE_ENV: NodeEnv }): Mailer {
  if (env.SENDGRID_API_KEY.trim() !== "") return sendGridMailer(env.SENDGRID_API_KEY.trim(), env.MAIL_FROM);
  if (env.NODE_ENV === "development") return directoryMailer(OUTBOX_DIRECTORY);
  return unconfiguredMailer();
}
