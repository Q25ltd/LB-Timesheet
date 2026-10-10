/**
 * The tracked mailer (D56) and the one kind of email it must NOT record as an
 * account's: a driver invitation (D63), whose `userId` is null because the
 * invitation records its own send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { trackedMailer } from "./emailDelivery.js";
import type { MailMessage, Mailer } from "./mailer.js";
import type { EmailDeliveryRepository } from "../repositories/emailDeliveryRepository.js";

function harness() {
  const recorded: { sesMessageId: string; userId: string }[] = [];
  const errors: string[] = [];
  const delivery: EmailDeliveryRepository = {
    suppressionReasons: () => Promise.resolve([]),
    recordSent: input => { recorded.push(input); return Promise.resolve(); },
    recordEvent: () => Promise.resolve("recorded"),
  };
  const ses: Mailer = { send: () => Promise.resolve("ses-message-1") };
  const mailer = trackedMailer(ses, delivery, { error: (_details, message) => { errors.push(message); } });
  return { mailer, recorded, errors };
}

const message = (userId: string | null): MailMessage => ({
  sender: "accounts", userId, to: "driver@example.com", subject: "s", text: "t", html: "<p>t</p>",
});

test("an account's email is recorded against that account (control)", async () => {
  const { mailer, recorded, errors } = harness();
  assert.equal(await mailer.send(message("user-1")), "ses-message-1");
  assert.deepEqual(recorded.map(r => r.userId), ["user-1"]);
  assert.deepEqual(errors, []);
});

test("an invitation email (no account) is sent and its id returned — but never recorded as an account's, and no failure is logged", async () => {
  const { mailer, recorded, errors } = harness();
  assert.equal(await mailer.send(message(null)), "ses-message-1", "the caller gets the id, to record it on the invitation");
  assert.deepEqual(recorded, [], "nothing enters the account email records (D56)");
  assert.deepEqual(errors, [], "skipping it is the rule, not a failure to report");
});
