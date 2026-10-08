/**
 * SES bounce and complaint notifications, delivered by Amazon SNS (D55).
 *
 *   POST /webhooks/ses   public — SNS cannot authenticate with a token; the
 *                                 message's SNS SIGNATURE is the credential
 *                                 (lib/sesNotifications.ts)
 *
 * Registered only when SES_NOTIFICATION_TOPIC_ARN is configured, and then it
 * accepts messages from that topic alone. Every refusal is the same generic
 * 403, so the endpoint says nothing about which check failed.
 *
 * A subscription is confirmed only for the configured topic, only after its
 * signature verifies, and only by fetching a SubscribeURL on an SNS host.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import type { EmailDeliveryRepository } from "../repositories/emailDeliveryRepository.js";
import {
  SNS_BODY_LIMIT,
  SesNotification,
  deliveryEventOf,
  SnsBody,
  SnsEnvelope,
  isSnsUrl,
  notificationRecord,
  snsVerifier,
  type SnsFetch,
} from "../lib/sesNotifications.js";

function notAllowed(): AppError {
  return new AppError(403, "Not allowed", "FORBIDDEN");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function registerSesNotificationRoutes(
  app: FastifyInstance,
  topicArn: string,
  fetchText: SnsFetch,
  delivery: EmailDeliveryRepository,
): void {
  const verify = snsVerifier({ topicArn, fetchText });

  app.post(
    "/webhooks/ses",
    { config: { authPosture: "public" }, bodyLimit: SNS_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // SNS posts JSON with Content-Type text/plain, so the body is a string.
      const body = SnsBody.safeParse(request.body);
      const envelope = SnsEnvelope.safeParse(body.success ? parseJson(body.data) : undefined);
      if (!envelope.success) throw new AppError(400, "Invalid request", "VALIDATION");
      const message = envelope.data;

      if (!(await verify(message))) throw notAllowed();

      switch (message.Type) {
        case "SubscriptionConfirmation": {
          if (!isSnsUrl(message.SubscribeURL)) throw notAllowed();
          await fetchText(message.SubscribeURL);
          request.log.info({ event: "ses.subscription-confirmed", topicArn }, "SES notification subscription confirmed");
          return reply.status(204).send();
        }
        case "UnsubscribeConfirmation": {
          request.log.warn({ event: "ses.unsubscribed", topicArn }, "SES notifications were unsubscribed from this endpoint");
          return reply.status(204).send();
        }
        case "Notification": {
          const notification = SesNotification.safeParse(parseJson(message.Message));
          if (!notification.success) {
            request.log.warn({ event: "ses.unrecognised", snsMessageId: message.MessageId }, "an SES notification could not be read");
            return reply.status(204).send();
          }
          // Recorded ONCE (D56); a redelivery of the same notification is a no-op.
          const event = deliveryEventOf(notification.data);
          const outcome = event === null ? "not-recorded" : await delivery.recordEvent(event);
          const record = notificationRecord(notification.data);
          if (record !== null) request.log.warn({ ...record, outcome }, "SES reported an undeliverable or unwanted email");
          return reply.status(204).send();
        }
      }
    },
  );
}
