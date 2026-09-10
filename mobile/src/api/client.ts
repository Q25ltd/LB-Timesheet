/**
 * The API client. One place that knows the wire format, so no screen has to.
 *
 * It distinguishes three outcomes a phone genuinely needs to tell apart, and
 * the distinction is the point: a driver in a yard with no signal must not be
 * shown "Email already registered".
 *
 *   ok        the request succeeded
 *   api       the server answered with the project's error envelope
 *   network   the request never got an answer (no signal, server down, timeout)
 */
import { apiBaseUrl } from "./config";

/** The project's one error envelope (CLAUDE.md). */
interface ApiErrorBody {
  error: string;
  code?: string;
  details?: { path: string; message: string }[];
}

export type ApiResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "api"; status: number; body: ApiErrorBody }
  | { kind: "network"; message: string };

/** How long to wait before calling it a network failure. */
const REQUEST_TIMEOUT_MS = 15_000;

function asErrorBody(payload: unknown): ApiErrorBody {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return { error: "Something went wrong" };
  }
  const record = payload as Record<string, unknown>;
  const body: ApiErrorBody = {
    error: typeof record["error"] === "string" ? record["error"] : "Something went wrong",
  };
  if (typeof record["code"] === "string") body.code = record["code"];

  // Field-level messages, only when they have the shape the server documents.
  const details = record["details"];
  if (Array.isArray(details)) {
    const parsed = details.flatMap(item => {
      if (typeof item !== "object" || item === null) return [];
      const entry = item as Record<string, unknown>;
      return typeof entry["path"] === "string" && typeof entry["message"] === "string"
        ? [{ path: entry["path"], message: entry["message"] }]
        : [];
    });
    if (parsed.length > 0) body.details = parsed;
  }
  return body;
}

export async function postJson<T>(path: string, payload: unknown): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method:  "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });
  } catch (error) {
    // No answer at all. NOT an API error -- the UI must say "connection",
    // never "email already registered", for a request that never arrived.
    return { kind: "network", message: error instanceof Error ? error.message : "Request failed" };
  } finally {
    clearTimeout(timeout);
  }

  let parsed: unknown = null;
  try {
    parsed = (await response.json()) as unknown;
  } catch {
    // A body we cannot read is only a problem when the status says failure;
    // a 2xx with no body is still a success for callers expecting nothing.
    if (!response.ok) return { kind: "api", status: response.status, body: { error: "Something went wrong" } };
  }

  if (!response.ok) return { kind: "api", status: response.status, body: asErrorBody(parsed) };
  return { kind: "ok", value: parsed as T };
}

// NOTE: no authenticated GET helper yet. `/auth/me` exists on the server
// and is proven by the API suite, but the app has no caller for it until
// session restore lands with login — an unused helper is code written and
// never imported.
