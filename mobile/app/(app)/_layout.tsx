/**
 * The authenticated area: its gate, and the stack everything authenticated
 * sits in.
 *
 * THE GATE IS UNCHANGED and still wraps everything below it. `app/index.tsx`
 * decides the signed-out default for `/`, but it guards `/` alone; the app
 * declares `"scheme": "lbtimesheets"` (app.json), so a deep link could
 * otherwise mount an authenticated screen directly. Because the check lives
 * here, above the navigators, it covers the tabs and the workflow at once — no
 * screen implements its own, and a screen added later inherits it. Same
 * polarity as the API's default-deny route hook (F-10, D16): forgetting fails
 * CLOSED.
 *
 *   restoring        HOLD. A refresh credential may be mid-redemption, which
 *                    is a network round trip. Calling that "not signed in"
 *                    would bounce a signed-in driver through the password form.
 *   authenticated    render the stack.
 *   unauthenticated  REDIRECT. Never a placeholder — a signed-out driver must
 *                    land somewhere they can act.
 *
 * WHY A STACK, with the tabs nested inside it. The four everyday destinations
 * are a place the app keeps; Start Shift is something the driver DOES. As a
 * sibling of the whole `(tabs)` group rather than a member of it, the workflow
 * is genuinely outside the tab navigator and shows no tab bar — so a driver
 * halfway through a shift form cannot leave it by tapping Timesheets.
 *
 * That is a structural guarantee, not a styling one: nothing here hides a bar,
 * checks a route name, or renders conditionally. `appNavigationStructure.test.tsx`
 * asserts the shape, so moving Start Shift back among the tabs turns it red.
 */
import { Redirect, Stack } from "expo-router";
import { Restoring } from "../../src/components/Restoring";
import { useAuth } from "../../src/auth/AuthContext";
import { colors } from "../../src/theme/index";

export default function AppLayout() {
  const { status } = useAuth();

  if (status === "restoring") return <Restoring />;
  if (status !== "authenticated") return <Redirect href="/sign-in" />;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="start-shift" />
      <Stack.Screen name="active-shift" />
    </Stack>
  );
}
