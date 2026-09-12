/**
 * The entry point, and the ONLY place the signed-out default is decided.
 *
 *   restoring        → hold. Render nothing but a quiet placeholder.
 *   authenticated    → the app (Today)
 *   unauthenticated  → SIGN IN (owner decision, 2026-09-11)
 *
 * A signed-out launch resolves to `/sign-in`, not `/register`: most launches
 * are a returning driver, so registration was the wrong default the moment
 * login existed. Registration is one tap away, and back again.
 *
 * THE `restoring` BRANCH IS THE IMPORTANT ONE. A refresh credential in
 * SecureStore is redeemed at startup, which is a network round trip. With a
 * boolean `isAuthenticated`, that moment reads as "not authenticated" and the
 * driver is sent to Sign-in and then bounced to Today — a visible flash that
 * also teaches them their session did not survive. Holding here removes it,
 * and the hold is bounded by the API client's own request timeout.
 *
 * This route guards `/` only. Every screen inside the authenticated group is
 * guarded by `app/(app)/_layout.tsx`, which applies the same three branches so
 * a deep link cannot reach an authenticated screen around this file.
 *
 * Note what is NOT here: no branch on whether the driver has a company. Zero
 * memberships is a fully authenticated state and routes exactly like any
 * other (D21).
 */
import { Redirect } from "expo-router";
import { Restoring } from "../src/components/Restoring";
import { useAuth } from "../src/auth/AuthContext";

export default function Index() {
  const { status } = useAuth();

  if (status === "restoring") return <Restoring />;
  return <Redirect href={status === "authenticated" ? "/today" : "/sign-in"} />;
}
