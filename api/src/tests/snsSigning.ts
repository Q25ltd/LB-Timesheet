/**
 * Test support: SNS messages signed the way Amazon SNS signs them, with a key
 * pair made for the test run. The canonical string is built HERE, from the
 * AWS documentation, independently of lib/sesNotifications.ts — so a mistake
 * there cannot hide by being reused to sign its own test messages.
 *
 * `fetchText` stands in for the network: it serves the test's public key as the
 * "certificate" at an SNS URL, and records every URL it was asked for.
 */
import { createSign, generateKeyPairSync } from "node:crypto";

export const TOPIC = "arn:aws:sns:us-east-1:463470971979:lb-timesheets-ses-events";
export const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";
export const SUBSCRIBE_URL = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=t";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const OTHER_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();

const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"];
const CONFIRMATION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];

export function sign(message: Record<string, string>, version: "1" | "2" = "1"): Record<string, string> {
  const keys = message["Type"] === "Notification" ? NOTIFICATION_KEYS : CONFIRMATION_KEYS;
  const canonical = keys.filter(key => message[key] !== undefined).map(key => `${key}\n${message[key] ?? ""}\n`).join("");
  const signature = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256").update(canonical, "utf8").sign(privateKey, "base64");
  return { ...message, SignatureVersion: version, Signature: signature, SigningCertURL: message["SigningCertURL"] ?? CERT_URL };
}

export function bounceNotification(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Type: "Notification",
    MessageId: "11111111-2222-3333-4444-555555555555",
    TopicArn: TOPIC,
    Message: JSON.stringify({
      notificationType: "Bounce",
      mail: { messageId: "ses-message-1", destination: ["Owner@Example.com"] },
      bounce: {
        feedbackId: "0100017f-feedback-0001", timestamp: new Date().toISOString(),
        bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "Owner@Example.com" }],
      },
    }),
    Timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** The same bounce as a CONFIGURATION SET publishes it: `eventType`, not `notificationType` (D58). */
export function bounceEvent(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...bounceNotification(),
    Message: JSON.stringify({
      eventType: "Bounce",
      mail: { messageId: "ses-message-1", destination: ["Owner@Example.com"], tags: { "ses:configuration-set": ["lb-timesheets"] } },
      bounce: {
        feedbackId: "0100017f-feedback-0002", timestamp: new Date().toISOString(),
        bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "Owner@Example.com" }],
      },
    }),
    ...overrides,
  };
}

export function subscriptionConfirmation(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Type: "SubscriptionConfirmation",
    MessageId: "66666666-7777-8888-9999-000000000000",
    TopicArn: TOPIC,
    Message: "You have chosen to subscribe to the topic.",
    Token: "token-from-sns",
    SubscribeURL: SUBSCRIBE_URL,
    Timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** A network stand-in. `wrongKey` serves a DIFFERENT public key at the certificate URL. */
export function fakeSns(options: { wrongKey?: boolean } = {}) {
  const fetched: string[] = [];
  return {
    fetched,
    fetchText: (url: string): Promise<string> => {
      fetched.push(url);
      if (url === CERT_URL) return Promise.resolve(options.wrongKey === true ? OTHER_PEM : PUBLIC_PEM);
      if (url.startsWith("https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription")) return Promise.resolve("<ConfirmSubscriptionResponse/>");
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    },
  };
}
