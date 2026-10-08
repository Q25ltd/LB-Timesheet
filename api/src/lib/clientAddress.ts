/**
 * WHO is asking, for rate limiting (F-15) — the one decision, used by every
 * limiter.
 *
 * Behind Railway's edge every connection comes from the proxy, so the socket
 * address is the PROXY's: keyed on it, every client would share one bucket
 * and one person's failed sign-ins would lock everyone out. Railway's edge
 * sets `X-Real-IP` to the client's address on every public request,
 * overwriting any copy the caller sent (Railway's guidance for rate limiting).
 *
 * So there are exactly two sources, chosen explicitly by CLIENT_IP_SOURCE:
 *
 *   socket     the TCP peer. Nothing a client sends is believed. The
 *              default for development and test, and correct for any
 *              deployment with no proxy in front.
 *   x-real-ip  Railway's edge-set header — accepted only as ONE valid IP
 *              address. Missing, repeated or malformed, it is ignored and
 *              the socket address used: a request that did not come
 *              through the edge falls into the proxy's shared bucket,
 *              never into a bucket of its own choosing.
 *
 * Deliberately NOT `X-Forwarded-For`, and Fastify's `trustProxy` stays off:
 * Railway's handling of that header is not reliably documented, and a
 * hop-count or "trust everything" setting is exactly how a client picks
 * its own address. Verified against the live edge at the first private
 * deployment (DEPLOYMENT.md).
 */
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import type { ClientIpSource } from "./env.schema.js";

/** All the resolver reads of a request: the socket peer and the headers. */
type AddressedRequest = Pick<FastifyRequest, "ip" | "headers">;

export function clientAddressOf(source: ClientIpSource): (request: AddressedRequest) => string {
  if (source === "socket") return request => request.ip;
  return request => {
    const header = request.headers["x-real-ip"];
    if (typeof header !== "string") return request.ip;
    const address = header.trim();
    return isIP(address) === 0 ? request.ip : address;
  };
}
