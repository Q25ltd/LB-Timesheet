/**
 * "At most N emails of one kind per address per hour" (owner decision B6) —
 * in-process, a sliding window per normalised address.
 *
 * Counted per REQUEST for an address, not per email actually sent, so that
 * on the public forgot-password path the count — and therefore the
 * behaviour — is identical whether or not the address has an account.
 *
 * Not a lockout: it never stops anyone signing in, and an address's window
 * empties by itself within the hour. It bounds how much mail one address can
 * be made to receive.
 *
 * Bounded memory: at most `maxTracked` addresses are remembered. Past that,
 * expired windows are pruned first and then the OLDEST entries dropped — a
 * flood of distinct addresses can make the throttle forget some, but never
 * grows the process without limit, and the per-IP limits still bound the
 * flood itself. In-process like the IP limiter: one API instance (D14).
 */
export interface SendThrottle {
  /** Record a request for `address` now; false when it is over the limit. */
  allow(address: string): boolean;
}

export function sendThrottle(options: {
  max: number;
  windowMs: number;
  maxTracked?: number;
  now?: () => number;
}): SendThrottle {
  const now = options.now ?? Date.now;
  const maxTracked = options.maxTracked ?? 10_000;
  const windows = new Map<string, number[]>();

  function live(times: number[] | undefined, at: number): number[] {
    return (times ?? []).filter(t => at - t < options.windowMs);
  }

  return {
    allow(address) {
      const at = now();
      const recent = live(windows.get(address), at);
      const allowed = recent.length < options.max;
      if (allowed) recent.push(at);

      windows.delete(address);          // re-insert: Map order is recency
      windows.set(address, recent);

      if (windows.size > maxTracked) {
        for (const [key, times] of windows) {
          if (live(times, at).length === 0) windows.delete(key);
        }
        for (const key of windows.keys()) {
          if (windows.size <= maxTracked) break;
          windows.delete(key);
        }
      }
      return allowed;
    },
  };
}
