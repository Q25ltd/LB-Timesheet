/**
 * The authenticated route group's gate — the ONE place a screen under `(app)`
 * is allowed to require a signed-in driver.
 *
 * THE DEFECT THIS CLOSES. `app/index.tsx` decides the signed-out default, but
 * it guards `/` and nothing else. `app.json` declares `"scheme":
 * "lbtimesheets"`, so `lbtimesheets://today` opened on a signed-out phone
 * mounted the authenticated screen directly. With no account to render, that
 * screen showed a "Signing you in…" placeholder which never signed anyone in
 * and never navigated — a dead end with no way forward and no way back.
 *
 * WHY IT LIVES HERE rather than in each screen. Structural prevention over
 * instruction: every screen added under `(app)` from now on is protected
 * without its author remembering anything, and forgetting fails CLOSED. It is
 * the same polarity as the API's default-deny route hook (F-10, D16) — the
 * runtime gate is the boundary, not a convention someone has to follow.
 *
 * THE THREE STATES, and why `restoring` is the one that matters:
 *
 *   restoring        HOLD. A refresh credential may be mid-redemption, which
 *                    is a network round trip. Treating it as "not signed in"
 *                    would send a signed-in driver to the password form and
 *                    then bounce them back — the flash `app/index.tsx` already
 *                    exists to prevent, and on a slow connection it reads as
 *                    having been logged out.
 *   authenticated    render the authenticated routes.
 *   unauthenticated  REDIRECT to sign-in. Never a placeholder: a signed-out
 *                    driver must land somewhere they can act.
 *
 * This file reads `AuthProvider` and changes nothing about it. It mints no
 * token, inspects no token, and decides nothing about company authority.
 */
import { Redirect, Stack } from "expo-router";
import { Restoring } from "../../src/components/Restoring";
import { useAuth } from "../../src/auth/AuthContext";
import { colors } from "../../src/theme/index";

export default function AppLayout() {
  const { status } = useAuth();

  if (status === "restoring") return <Restoring />;
  if (status !== "authenticated") return <Redirect href="/sign-in" />;

  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
