/**
 * Bounce and complaint notifications from Amazon SES, delivered by Amazon SNS
 * (D55).
 *
 * SES publishes each bounce and complaint for `logisticbay.com` to ONE SNS
 * topic, which POSTs it to this API. The endpoint is necessarily public — SNS
 * cannot present a token — so authenticity rests entirely on SNS's message
 * signature, checked here before anything is believed or done:
 *
 *   the topic is the configured one          (anything else: refused)
 *   the timestamp is recent                  (a replayed message: refused)
 *   the signing certificate comes from       (any other host, scheme or
 *     https://sns.<region>.amazonaws.com/…pem  file: refused, never fetched)
 *   the RSA signature over SNS's canonical   (SignatureVersion 1 = SHA1,
 *     string verifies against it               2 = SHA256)
 *
 * Only then is a subscription confirmed (its SubscribeURL must ALSO be an SNS
 * host) or an event acted on.
 *
 * WHAT HAPPENS TO A BOUNCE OR COMPLAINT (D56). SES's account-level
 * suppression list stops it sending to a hard-bounced or complaining address.
 * This application records each one ONCE (`deliveryEventOf` →
 * emailDeliveryRepository): the event against the email — and so the account —
 * it concerns, and the address on its own suppression list, so it stops
 * asking and the account can be told and correct it. A transient bounce is
 * recorded and suppresses nothing. The log line carries the recipient's
 * domain and a digest — never the address.
 */
import { createHash, createVerify } from "node:crypto";
import { z } from "zod";
import type { DeliveryEventInput } from "../repositories/emailDeliveryRepository.js";
import { normaliseEmail } from "./accountEmail.js";

/** SNS posts JSON as text/plain; a message is at most 256 KB. */
export const SNS_BODY_LIMIT = 300_000;
export const SnsBody = z.string().min(1).max(SNS_BODY_LIMIT);

const MessageFields = {
  MessageId:        z.string().min(1).max(128),
  TopicArn:         z.string().min(1).max(400),
  Message:          z.string().max(SNS_BODY_LIMIT),
  Timestamp:        z.string().min(1).max(40),
  SignatureVersion: z.enum(["1", "2"]),
  Signature:        z.string().min(1).max(4096),
  SigningCertURL:   z.string().min(1).max(1024),
};

const ConfirmationFields = {
  ...MessageFields,
  Token:        z.string().min(1).max(4096),
  SubscribeURL: z.string().min(1).max(2048),
};

export const SnsEnvelope = z.discriminatedUnion("Type", [
  z.object({ Type: z.literal("Notification"), ...MessageFields, Subject: z.string().max(512).optional() }),
  z.object({ Type: z.literal("SubscriptionConfirmation"), ...ConfirmationFields }),
  z.object({ Type: z.literal("UnsubscribeConfirmation"), ...ConfirmationFields }),
]);
export type SnsEnvelope = z.infer<typeof SnsEnvelope>;

/** Reads a URL as text. Injected so tests never reach the network. */
export type SnsFetch = (url: string) => Promise<string>;

/** A message older than this (or this far in the future) is refused as a replay. */
const MAX_MESSAGE_AGE_MS = 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const SNS_HOST = /^sns\.[a-z]{2}(-[a-z]+)+-\d\.amazonaws\.com$/;

/** True only for an https URL on an Amazon SNS host — the only place SNS certificates and confirmations live. */
export function isSnsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && SNS_HOST.test(url.hostname);
}

function isSigningCertUrl(raw: string): boolean {
  return isSnsUrl(raw) && new URL(raw).pathname.endsWith(".pem");
}

/** The exact string SNS signs, per message type (AWS SNS documentation). */
function canonicalString(envelope: SnsEnvelope): string {
  const fields: [string, string][] = envelope.Type === "Notification"
    ? [
        ["Message", envelope.Message],
        ["MessageId", envelope.MessageId],
        ...(envelope.Subject === undefined ? [] : [["Subject", envelope.Subject] satisfies [string, string]]),
        ["Timestamp", envelope.Timestamp],
        ["TopicArn", envelope.TopicArn],
        ["Type", envelope.Type],
      ]
    : [
        ["Message", envelope.Message],
        ["MessageId", envelope.MessageId],
        ["SubscribeURL", envelope.SubscribeURL],
        ["Timestamp", envelope.Timestamp],
        ["Token", envelope.Token],
        ["TopicArn", envelope.TopicArn],
        ["Type", envelope.Type],
      ];
  return fields.map(([key, value]) => `${key}\n${value}\n`).join("");
}

/**
 * The one authenticity check. Returns false — never throws — for anything that
 * is not a recent message, signed by SNS, for `topicArn`.
 */
export function snsVerifier(options: { topicArn: string; fetchText: SnsFetch; now?: () => number }) {
  const now = options.now ?? Date.now;
  const certificates = new Map<string, string>();

  async function certificate(url: string): Promise<string> {
    const cached = certificates.get(url);
    if (cached !== undefined) return cached;
    const pem = await options.fetchText(url);
    if (certificates.size >= 16) certificates.clear();
    certificates.set(url, pem);
    return pem;
  }

  return async function verify(envelope: SnsEnvelope): Promise<boolean> {
    if (envelope.TopicArn !== options.topicArn) return false;

    const sent = Date.parse(envelope.Timestamp);
    if (Number.isNaN(sent) || now() - sent > MAX_MESSAGE_AGE_MS || sent - now() > MAX_FUTURE_SKEW_MS) return false;

    if (!isSigningCertUrl(envelope.SigningCertURL)) return false;
    try {
      const pem = await certificate(envelope.SigningCertURL);
      return createVerify(envelope.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256")
        .update(canonicalString(envelope), "utf8")
        .verify(pem, envelope.Signature, "base64");
    } catch {
      // An unreachable certificate or one that is not a key is not a signature.
      return false;
    }
  };
}

const Recipient = z.object({ emailAddress: z.string().min(1).max(320) });

/** The parts of an SES identity notification this application records. */
export const SesNotification = z.object({
  notificationType: z.enum(["Bounce", "Complaint", "Delivery"]),
  mail: z.object({ messageId: z.string().min(1).max(256) }),
  bounce: z.object({
    feedbackId:        z.string().min(1).max(256),
    timestamp:         z.string().min(1).max(40),
    bounceType:        z.string().max(64),
    bounceSubType:     z.string().max(64),
    bouncedRecipients: z.array(Recipient).max(100),
  }).optional(),
  complaint: z.object({
    feedbackId:            z.string().min(1).max(256),
    timestamp:             z.string().min(1).max(40),
    complaintFeedbackType: z.string().max(64).optional(),
    complainedRecipients:  z.array(Recipient).max(100),
  }).optional(),
});
export type SesNotification = z.infer<typeof SesNotification>;

/** A recipient as it may be logged: its domain, and a digest — never the address. */
function recipientReference(address: string): { domain: string; digest: string } {
  const normalised = normaliseEmail(address);
  const at = normalised.lastIndexOf("@");
  return {
    domain: at === -1 ? "" : normalised.slice(at + 1),
    digest: createHash("sha256").update(normalised).digest("hex").slice(0, 16),
  };
}

/** What is logged for one notification. Delivery notifications are not recorded. */
export function notificationRecord(notification: SesNotification): Record<string, unknown> | null {
  if (notification.notificationType === "Bounce" && notification.bounce !== undefined) {
    return {
      event:          "ses.bounce",
      sesMessageId:   notification.mail.messageId,
      bounceType:     notification.bounce.bounceType,
      bounceSubType:  notification.bounce.bounceSubType,
      recipients:     notification.bounce.bouncedRecipients.map(r => recipientReference(r.emailAddress)),
    };
  }
  if (notification.notificationType === "Complaint" && notification.complaint !== undefined) {
    return {
      event:          "ses.complaint",
      sesMessageId:   notification.mail.messageId,
      feedbackType:   notification.complaint.complaintFeedbackType ?? null,
      recipients:     notification.complaint.complainedRecipients.map(r => recipientReference(r.emailAddress)),
    };
  }
  return null;
}

/**
 * What one notification records (D56), or null when it records nothing — a
 * delivery, or a time SES did not say. Only a PERMANENT bounce suppresses;
 * Transient and Undetermined bounces are recorded as transient. A complaint
 * suppresses, and is its own kind.
 */
export function deliveryEventOf(notification: SesNotification): DeliveryEventInput | null {
  const { bounce, complaint } = notification;
  if (notification.notificationType === "Bounce" && bounce !== undefined) {
    const occurredAt = new Date(bounce.timestamp);
    if (Number.isNaN(occurredAt.getTime())) return null;
    const hard = bounce.bounceType === "Permanent";
    return {
      feedbackId:   bounce.feedbackId,
      kind:         hard ? "hard_bounce" : "transient_bounce",
      detail:       bounce.bounceSubType === "" ? null : bounce.bounceSubType,
      sesMessageId: notification.mail.messageId,
      occurredAt,
      suppress:     hard ? bounce.bouncedRecipients.map(r => ({ email: normaliseEmail(r.emailAddress), reason: "hard_bounce" as const })) : [],
    };
  }
  if (notification.notificationType === "Complaint" && complaint !== undefined) {
    const occurredAt = new Date(complaint.timestamp);
    if (Number.isNaN(occurredAt.getTime())) return null;
    return {
      feedbackId:   complaint.feedbackId,
      kind:         "complaint",
      detail:       complaint.complaintFeedbackType ?? null,
      sesMessageId: notification.mail.messageId,
      occurredAt,
      suppress:     complaint.complainedRecipients.map(r => ({ email: normaliseEmail(r.emailAddress), reason: "complaint" as const })),
    };
  }
  return null;
}

/** Production's reader: a bounded GET, no redirects, a 5-second limit. */
export async function fetchSnsText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`SNS request failed: HTTP ${String(response.status)}`);
  const text = await response.text();
  if (text.length > 64_000) throw new Error("SNS response too large");
  return text;
}
