import type { FastifyReply } from "fastify";

/**
 * The ONE error envelope. Never write reply.status(4xx).send({ error: "..." })
 * inline — always go through these helpers (see CLAUDE.md).
 */
interface ErrorBody {
  error: string;
  code?: string;
  details?: unknown;
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
