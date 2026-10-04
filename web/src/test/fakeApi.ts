import { vi } from "vitest";
import { API_BASE } from "../auth/apiBase";

/**
 * A scripted stand-in for the Fastify API, installed as `fetch`.
 *
 * Each handler answers one `METHOD /path`; anything unscripted is the API's
 * canonical 401, which is also what an anonymous visitor's refresh gets — so
 * a page rendered with no script behaves as signed out. Every call is
 * recorded, with its credentials mode and headers, so a test can assert HOW
 * the page talked to the API, not only what it showed.
 */
interface RecordedCall {
  method: string;
  path: string;
  credentials: RequestCredentials | undefined;
  authorization: string | null;
  body: unknown;
}

type Handler = (call: RecordedCall) => { status: number; body?: unknown } | "offline";

export interface FakeApi {
  calls: RecordedCall[];
  on(route: string, handler: Handler | { status: number; body?: unknown }): void;
}

const UNAUTHENTICATED = { status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } };

export function installFakeApi(): FakeApi {
  const routes = new Map<string, Handler>();
  const calls: RecordedCall[] = [];

  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const call: RecordedCall = {
      method: init.method ?? "GET",
      path: url.href.startsWith(API_BASE) ? url.pathname : url.href,
      credentials: init.credentials,
      authorization: headers.get("authorization"),
      body: typeof init.body === "string" ? JSON.parse(init.body) as unknown : null,
    };
    calls.push(call);
    const handler = routes.get(`${call.method} ${call.path}`);
    const answer = handler === undefined ? UNAUTHENTICATED : handler(call);
    if (answer === "offline") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve(new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status }));
  });

  return {
    calls,
    on(route, handler) {
      routes.set(route, typeof handler === "function" ? handler : () => handler);
    },
  };
}

const USER = { id: "user-1", firstName: "Nerijus", lastName: "Kuizinas", email: "owner@example.com" };

export function account(overrides: { emailVerified?: boolean; memberships?: unknown[]; pendingCompanyRegistration?: unknown } = {}) {
  return {
    user: USER,
    emailVerified: overrides.emailVerified ?? true,
    memberships: overrides.memberships ?? [],
    pendingCompanyRegistration: overrides.pendingCompanyRegistration ?? null,
  };
}

/** An unfinished company registration, as `/auth/me` reports it (D51). */
export const PENDING = { companyName: "Kuizinas Haulage Ltd", timezone: "Europe/Vilnius" };

export const MEMBERSHIP = { membershipId: "m-1", companyId: "c-1", companyName: "Kuizinas Haulage Ltd", role: "admin" };
