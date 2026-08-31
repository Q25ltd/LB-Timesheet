import { errorCodes, type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

/**
 * The ONE error envelope. Every client-visible error — helper-sent, thrown,
 * validation, unknown route, or unexpected crash — leaves the API in this
 * shape and no other. Never write reply.status(4xx).send({...}) inline; go
 * through the helpers or throw an AppError (see CLAUDE.md).
 */
interface ErrorBody {
  error: string;
  code?: string;
  details?: unknown;
}

/**
 * A deliberate, client-safe application error. Throw it from a route or
 * service when the failure is part of the API's contract — the global handler
 * preserves its status, message, code and details exactly.
 *
 * Anything ELSE that reaches the handler is treated as an internal fault:
 * logged in full server-side, masked to a fixed message for the client.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function send(reply: FastifyReply, status: number, error: string, code?: string, details?: unknown) {
  const body: ErrorBody = { error };
  if (code !== undefined) body.code = code;
  if (details !== undefined) body.details = details;
  return reply.status(status).send(body);
}

export const badRequest   = (r: FastifyReply, e: string, code?: string, d?: unknown) => send(r, 400, e, code, d);
export const unauthorized = (r: FastifyReply, e = "Not authenticated",        code?: string) => send(r, 401, e, code);
export const forbidden    = (r: FastifyReply, e = "Not allowed",              code?: string) => send(r, 403, e, code);
export const notFound     = (r: FastifyReply, e = "Not found",                code?: string) => send(r, 404, e, code);
export const conflict     = (r: FastifyReply, e: string, code?: string, d?: unknown) => send(r, 409, e, code, d);
export const serverError  = (r: FastifyReply, e = "Something went wrong",     code?: string) => send(r, 500, e, code);

/** The fixed body every unexpected failure returns. Deliberately constant. */
const INTERNAL: ErrorBody = { error: "Something went wrong", code: "INTERNAL" };

/**
 * A private runtime identity for validation errors created by Fastify through
 * the schema formatter registered below. A normal application Error cannot
 * obtain this identity by copying `validation`, `code`, or `statusCode` fields.
 */
class TrustedValidationError extends Error {}

/**
 * The exact set of Fastify-authored error constructors trusted to pass their own
 * status and message straight to the client. Each of these is a fixed,
 * non-interpolated string describing the CLIENT's own malformed request
 * (fastify/lib/errors.js) -- never server state, never a provider detail.
 *
 * `instanceof` is deliberate: Fastify's constructors carry non-enumerable
 * runtime identity from @fastify/error. Copying their public fields onto an
 * arbitrary Error does not make it an instance. A future Fastify error -- even
 * one with a familiar-looking code -- is NOT trusted until its constructor is
 * deliberately added here after its message is checked as client-safe.
 */
const SAFE_FASTIFY_ERROR_TYPES = [
  errorCodes.FST_ERR_CTP_BODY_TOO_LARGE,
  errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE,
  errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH,
  errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY,
  errorCodes.FST_ERR_CTP_INVALID_JSON_BODY,
];

function isSafeFastifyError(error: FastifyError): boolean {
  return SAFE_FASTIFY_ERROR_TYPES.some(ErrorType => error instanceof ErrorType);
}

/**
 * Global error + not-found handling. Lives HERE, next to the envelope, so the
 * check-rules "one error envelope" rule (which allows reply.status only in
 * this file) covers it — and so nobody can change the envelope and the
 * handlers separately.
 *
 * Decision table:
 *   AppError                        → its own status/message/code/details
 *   Fastify validation failure      → 400 VALIDATION, with the validation list
 *     (the list describes the CLIENT's request against the declared schema —
 *      client-safe by construction)
 *   other Fastify 4xx (rate limit,
 *     bad content type, …)          → that status, its message and FST_ code
 *     (4xx messages are written for clients; 5xx messages are not)
 *   everything else                 → 500, full error LOGGED, fixed body sent.
 *     Exception text, Prisma codes, SQL, stack traces and provider details
 *     never reach the client — in ANY environment, not just production, so
 *     the masking cannot depend on NODE_ENV being set correctly.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  // Fastify's default validation error is a plain Error decorated with public
  // fields, which is indistinguishable from an application Error that copied
  // those fields. Create it through our private class so provenance, not shape,
  // decides whether validation details are safe to return.
  app.setSchemaErrorFormatter(() => new TrustedValidationError("Invalid request"));

  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    return send(reply, 404, "Not found", "NOT_FOUND");
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      return send(reply, error.statusCode, error.message, error.code, error.details);
    }

    if (error instanceof TrustedValidationError) {
      return send(reply, 400, "Invalid request", "VALIDATION", error.validation);
    }

    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 400 && status < 500 && isSafeFastifyError(error)) {
      return send(reply, status, error.message, error.code);
    }

    // Unexpected. The full error goes to the server log; the client gets the
    // fixed body. request.log carries the request id, so the two correlate.
    request.log.error({ err: error }, "unhandled error");
    return send(reply, 500, INTERNAL.error, INTERNAL.code);
  });
}
