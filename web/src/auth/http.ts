import { API_BASE } from "./apiBase";
import { parseErrorCode } from "./responses";

/**
 * One request to the API, and its outcome as data.
 *
 *   ok       a 2xx whose body passed its parser
 *   refused  any other status, with the error envelope's `code` if it had one
 *   offline  the request never got an answer
 *
 * `cookie: true` is ONLY for the `/auth/web/*` routes: it sends the HttpOnly
 * refresh cookie (D45). Everything else omits credentials and carries an
 * access token from memory in the Authorization header.
 */
export type ApiResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "refused"; status: number; code: string | null }
  | { kind: "offline" };

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: object;
  token?: string;
  cookie?: boolean;
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions,
  parse: (body: unknown) => T | null,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? "POST",
      headers,
      credentials: options.cookie === true ? "include" : "omit",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    return { kind: "offline" };
  }

  const raw = await response.text();
  let body: unknown = null;
  if (raw !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      return { kind: "refused", status: response.status, code: null };
    }
  }

  if (!response.ok) return { kind: "refused", status: response.status, code: parseErrorCode(body) };
  const value = parse(body);
  return value === null ? { kind: "refused", status: response.status, code: "MALFORMED_RESPONSE" } : { kind: "ok", value };
}
