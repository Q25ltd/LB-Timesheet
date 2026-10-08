/**
 * The SNS signature check for SES bounces and complaints (D55): every way a
 * forged, altered, replayed or mis-sourced message could pass, refused — with
 * positive controls, so the refusals are not vacuous.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SnsEnvelope, deliveryEventOf, isSnsUrl, notificationRecord, SesNotification, snsVerifier } from "./sesNotifications.js";
import { CERT_URL, TOPIC, bounceNotification, fakeSns, sign, subscriptionConfirmation } from "../tests/snsSigning.js";

async function verifies(message: Record<string, string>, options: { wrongKey?: boolean; topic?: string } = {}): Promise<boolean> {
  const sns = fakeSns(options);
  return snsVerifier({ topicArn: options.topic ?? TOPIC, fetchText: sns.fetchText })(SnsEnvelope.parse(message));
}

test("a genuine notification verifies, with SignatureVersion 1 (SHA1) and 2 (SHA256)", async () => {
  assert.equal(await verifies(sign(bounceNotification(), "1")), true);
  assert.equal(await verifies(sign(bounceNotification(), "2")), true);
  assert.equal(await verifies(sign(bounceNotification({ Subject: "Amazon SES Email Event Notification" }))), true, "Subject is part of what is signed");
  assert.equal(await verifies(sign(subscriptionConfirmation())), true);
});

test("any change after signing is refused — message, recipient, type, topic or subscribe URL", async () => {
  const signed = sign(bounceNotification());
  assert.equal(await verifies({ ...signed, Message: signed["Message"]?.replace("Permanent", "Transient") ?? "" }), false);
  assert.equal(await verifies({ ...signed, MessageId: "forged-id" }), false);
  assert.equal(await verifies({ ...signed, Subject: "added after signing" }), false);
  const confirmation = sign(subscriptionConfirmation());
  assert.equal(await verifies({ ...confirmation, SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=other" }), false);
});

test("a message for ANOTHER topic is refused even when correctly signed", async () => {
  assert.equal(await verifies(sign(bounceNotification({ TopicArn: "arn:aws:sns:us-east-1:111111111111:someone-else" })), { topic: TOPIC }), false);
});

test("a key that is not SNS's — the right URL serving a different key — is refused", async () => {
  assert.equal(await verifies(sign(bounceNotification()), { wrongKey: true }), false);
});

test("a certificate from anywhere but an https SNS host is refused WITHOUT being fetched", async () => {
  for (const url of [
    "http://sns.us-east-1.amazonaws.com/cert.pem",
    "https://sns.us-east-1.amazonaws.com.evil.example/cert.pem",
    "https://evil.example/sns.us-east-1.amazonaws.com/cert.pem",
    "https://sns.us-east-1.amazonaws.com:8443/cert.pem",
    "https://user@sns.us-east-1.amazonaws.com/cert.pem",
    "https://sns.us-east-1.amazonaws.com/cert.txt",
    "not a url",
  ]) {
    const sns = fakeSns();
    const ok = await snsVerifier({ topicArn: TOPIC, fetchText: sns.fetchText })(SnsEnvelope.parse(sign(bounceNotification({ SigningCertURL: url }))));
    assert.equal(ok, false, url);
    assert.deepEqual(sns.fetched, [], `${url} must never be fetched`);
  }
  assert.equal(isSnsUrl(CERT_URL), true, "positive control");
});

test("a stale (replayed) or future-dated message is refused", async () => {
  assert.equal(await verifies(sign(bounceNotification({ Timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }))), false);
  assert.equal(await verifies(sign(bounceNotification({ Timestamp: new Date(Date.now() + 30 * 60 * 1000).toISOString() }))), false);
  assert.equal(await verifies(sign(bounceNotification({ Timestamp: "yesterday" }))), false);
});

test("what is recorded names the bounce, never the address: the domain and a digest only", () => {
  const record = notificationRecord(SesNotification.parse(JSON.parse(bounceNotification()["Message"] ?? "")));
  assert.deepEqual(record, {
    event: "ses.bounce",
    sesMessageId: "ses-message-1",
    bounceType: "Permanent",
    bounceSubType: "General",
    // The address is normalised (trim + lowercase) before it is digested.
    recipients: [{ domain: "example.com", digest: createHash("sha256").update("owner@example.com").digest("hex").slice(0, 16) }],
  });
  assert.ok(!JSON.stringify(record).toLowerCase().includes("owner@"), "the address itself is never recorded");
  const complaint = notificationRecord(SesNotification.parse({
    notificationType: "Complaint", mail: { messageId: "m2" },
    complaint: { feedbackId: "f-2", timestamp: "2026-10-08T12:00:00.000Z", complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: "a@b.example" }] },
  }));
  assert.equal(complaint?.["event"], "ses.complaint");
  assert.equal(notificationRecord(SesNotification.parse({ notificationType: "Delivery", mail: { messageId: "m3" } })), null);
});

// ── Configuration-set events (D58) ──────────────────────────────────────────
// SES publishes a configuration set's events with `eventType` where identity
// notifications say `notificationType`; the bounce and complaint bodies are
// the same. Both formats must record the same thing — and a message that
// names two different kinds is not trusted to mean either.

const BOUNCE_BODY = {
  mail: { messageId: "ses-message-9", tags: { "ses:configuration-set": ["lb-timesheets"] } },
  bounce: {
    feedbackId: "feedback-cs-1", timestamp: "2026-10-08T12:00:00.000Z",
    bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "Owner@Example.com" }],
  },
};
const COMPLAINT_BODY = {
  mail: { messageId: "ses-message-10" },
  complaint: { feedbackId: "feedback-cs-2", timestamp: "2026-10-08T12:00:00.000Z", complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: "a@b.example" }] },
};

test("a configuration-set Bounce event records exactly what the identity notification does", () => {
  const asEvent = SesNotification.parse({ eventType: "Bounce", ...BOUNCE_BODY });
  const asNotification = SesNotification.parse({ notificationType: "Bounce", ...BOUNCE_BODY });
  assert.deepEqual(deliveryEventOf(asEvent), deliveryEventOf(asNotification));
  assert.deepEqual(deliveryEventOf(asEvent), {
    feedbackId: "feedback-cs-1", kind: "hard_bounce", detail: "General", sesMessageId: "ses-message-9",
    occurredAt: new Date("2026-10-08T12:00:00.000Z"),
    suppress: [{ email: "owner@example.com", reason: "hard_bounce" }],
  });
  assert.equal(notificationRecord(asEvent)?.["event"], "ses.bounce");
});

test("a configuration-set Complaint event records exactly what the identity notification does", () => {
  const asEvent = SesNotification.parse({ eventType: "Complaint", ...COMPLAINT_BODY });
  assert.deepEqual(deliveryEventOf(asEvent), deliveryEventOf(SesNotification.parse({ notificationType: "Complaint", ...COMPLAINT_BODY })));
  assert.equal(deliveryEventOf(asEvent)?.kind, "complaint");
});

test("other configuration-set events are read but record nothing", () => {
  for (const eventType of ["Send", "Delivery", "Reject", "Open", "Click", "DeliveryDelay", "Rendering Failure", "Subscription"]) {
    const parsed = SesNotification.parse({ eventType, mail: { messageId: "m" } });
    assert.equal(deliveryEventOf(parsed), null, eventType);
    assert.equal(notificationRecord(parsed), null, eventType);
  }
});

test("a message naming no kind, or two DIFFERENT kinds, is refused", () => {
  assert.equal(SesNotification.safeParse({ ...BOUNCE_BODY }).success, false, "no kind at all");
  assert.equal(SesNotification.safeParse({ eventType: "Delivery", notificationType: "Bounce", ...BOUNCE_BODY }).success, false,
    "a bounce body labelled two ways is not trusted");
  assert.equal(SesNotification.safeParse({ eventType: 7, ...BOUNCE_BODY }).success, false);
  assert.equal(SesNotification.safeParse({ eventType: "x".repeat(65), ...BOUNCE_BODY }).success, false);
  assert.ok(deliveryEventOf(SesNotification.parse({ eventType: "Bounce", notificationType: "Bounce", ...BOUNCE_BODY })) !== null,
    "two labels that agree are fine");
});
