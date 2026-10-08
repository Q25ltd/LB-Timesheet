/**
 * The Amazon SES mailer (D55) — what it asks SES to send, proven against a
 * stand-in client. Nothing here reaches AWS: no credentials exist in tests,
 * and `sesMailer` takes its client as an argument.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { MAIL_REPLY_TO, MAIL_SENDERS, mailTransportFor, sesMailer, type MailMessage } from "./mailer.js";

function capturing(failure?: Error) {
  const sent: SendEmailCommand[] = [];
  return {
    sent,
    client: {
      send(command: SendEmailCommand): Promise<{ MessageId?: string }> {
        sent.push(command);
        return failure === undefined ? Promise.resolve({ MessageId: "ses-message-id" }) : Promise.reject(failure);
      },
    },
  };
}

const MESSAGE: MailMessage = {
  sender: "accounts",
  userId: "user-1",
  to: "owner@example.com",
  subject: "Confirm your email address — LogisticBay Timesheets",
  text: "Hello Ąžuolas",
  html: "<p>Hello Ąžuolas</p>",
};

test("each kind of mail is sent FROM its own fixed address, with Reply-To support@", async () => {
  assert.deepEqual(MAIL_SENDERS, {
    accounts: "accounts@logisticbay.com",
    security: "security@logisticbay.com",
    timesheets: "timesheets@logisticbay.com",
  });
  assert.equal(MAIL_REPLY_TO, "support@logisticbay.com");

  for (const sender of ["accounts", "security", "timesheets"] as const) {
    const { sent, client } = capturing();
    await sesMailer(client, "lb-timesheets").send({ ...MESSAGE, sender });
    assert.equal(sent[0]?.input.FromEmailAddress, MAIL_SENDERS[sender]);
    assert.deepEqual(sent[0]?.input.ReplyToAddresses, ["support@logisticbay.com"]);
  }
});

test("one message, one recipient — the account's own address, no CC, no BCC — and the content as written, in UTF-8; SES's message id is returned", async () => {
  const { sent, client } = capturing();
  assert.equal(await sesMailer(client, "lb-timesheets").send(MESSAGE), "ses-message-id", "what a later bounce will name (D56)");
  assert.equal(sent.length, 1);
  const input = sent[0]?.input;
  assert.deepEqual(input?.Destination, { ToAddresses: ["owner@example.com"] });
  assert.deepEqual(input?.Content?.Simple, {
    Subject: { Data: MESSAGE.subject, Charset: "UTF-8" },
    Body: { Text: { Data: MESSAGE.text, Charset: "UTF-8" }, Html: { Data: MESSAGE.html, Charset: "UTF-8" } },
  });
});

test("an SES failure is rethrown WITHOUT its message — SES errors can name the recipient, and failures are logged", async () => {
  const awsError = Object.assign(new Error("Email address is not verified. The following identities failed the check in region US-EAST-1: owner@example.com"), {
    name: "MessageRejected",
    $metadata: { httpStatusCode: 400 },
  });
  const { client } = capturing(awsError);
  await assert.rejects(sesMailer(client, "lb-timesheets").send(MESSAGE), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "SES send failed: MessageRejected (HTTP 400)");
    assert.ok(!error.message.includes("@"), "no address in what gets logged");
    return true;
  });
});

test("EVERY SES send names the Timesheets configuration set — the only way its bounces and complaints reach this product (D58)", async () => {
  for (const sender of ["accounts", "security", "timesheets"] as const) {
    const { sent, client } = capturing();
    await sesMailer(client, "lb-timesheets").send({ ...MESSAGE, sender });
    assert.equal(sent[0]?.input.ConfigurationSetName, "lb-timesheets", sender);
  }
});

test("an SES mailer cannot be built without a configuration set", () => {
  const { client } = capturing();
  for (const name of ["", "   "]) {
    assert.throws(() => sesMailer(client, name), /configuration set/);
  }
});

test("the development outbox writes the message as SES would send it — resolved From and Reply-To included", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lbts-outbox-test-"));
  try {
    const { mailer, outbox } = mailTransportFor({ MAIL_TRANSPORT: "outbox", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", SES_CONFIGURATION_SET: "" }, directory);
    assert.equal(outbox, directory);
    assert.equal(await mailer.send({ ...MESSAGE, sender: "security" }), null, "the outbox sends nothing to a provider, so there is no message id to record");
    const [name] = await readdir(directory);
    const written: unknown = JSON.parse(await readFile(join(directory, name ?? ""), "utf8"));
    assert.deepEqual(written, { from: "security@logisticbay.com", replyTo: "support@logisticbay.com", ...MESSAGE, sender: "security" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
