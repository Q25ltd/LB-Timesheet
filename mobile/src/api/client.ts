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
import { apiBaseUrl, describeApiResolution } from "./config";

/** The project's one error envelope (CLAUDE.md). */
interface ApiErrorBody {
  error: string;
  code?: string;
  details?: { path: string; message: string }[];
}

export type ApiResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "api"; status: number; body: ApiErrorBody }
  // `detail` is DEVELOPMENT-ONLY and is null in a production build. A
  // connection failure while developing is nearly always a wrong address,
  // and "check your signal" points the reader at the wrong thing entirely.
  | { kind: "network"; message: string; detail: string | null };

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

/**
 * What to say, in development only, when a request never reached anywhere.
 *
 * Returns null in production: an end user has no use for an internal
 * hostname, and putting one on screen leaks the developer's LAN layout.
 */
function unreachable(url: string): string | null {
  return __DEV__ ? `Could not reach ${url} (${describeApiResolution()})` : null;
}

/**
 * The one place a request is built.
 *
 * `token` is the short-lived access token and travels in the Authorization
 * header — never in the URL, never in the body, never in a query string, so
 * it cannot end up in a server log line or a proxy's access log. It is
 * omitted entirely rather than sent empty when absent.
 */
async function send<T>(
  path: string,
  init: { method: "GET" | "POST"; payload?: unknown; token?: string },
): Promise<ApiResult<T>> {
  const url = `${apiBaseUrl()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method:  init.method,
      headers: {
        "content-type": "application/json",
        accept:         "application/json",
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.payload === undefined ? {} : { body: JSON.stringify(init.payload) }),
      signal: controller.signal,
    });
  } catch (error) {
    // No answer at all. NOT an API error -- the UI must say "connection",
    // never "email already registered", for a request that never arrived.
    return { kind: "network", message: error instanceof Error ? error.message : "Request failed", detail: unreachable(url) };
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

export function postJson<T>(path: string, payload: unknown, token?: string): Promise<ApiResult<T>> {
  return send<T>(path, token === undefined ? { method: "POST", payload } : { method: "POST", payload, token });
}

export function getJson<T>(path: string, token: string): Promise<ApiResult<T>> {
  return send<T>(path, { method: "GET", token });
}

/**
 * A POST with no body and no response body — logout.
 *
 * `204 No Content` is a success with nothing to parse, which `send` already
 * handles: an unreadable body is only a problem when the status says failure.
 */
export function postEmpty(path: string, token: string): Promise<ApiResult<unknown>> {
  return send<unknown>(path, { method: "POST", token });
}
