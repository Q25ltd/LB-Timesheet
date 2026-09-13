/**
 * The Start Shift workflow route. Wiring only.
 *
 * It sits inside `(app)`, so the route-group gate protects it exactly as it
 * protects the four tabs — there is no second authentication check here and
 * must not be. It is NOT one of `APP_TABS`, so the bar offers no control for
 * it: Start Shift is an operational workflow launched from Home, not a
 * permanent destination.
 */
import { router } from "expo-router";
import { StartShiftScreen } from "../../src/screens/StartShiftScreen";
import { useAuth } from "../../src/auth/AuthContext";

export default function StartShiftRoute() {
  const { account } = useAuth();

  // The gate renders this route only when the provider is `authenticated`, and
  // `account` is set in the same update as that status. A null here would be a
  // wiring defect rather than a driver state.
  if (account === null) return null;

  return (
    <StartShiftScreen
      // ACTIVE memberships, as the authenticated account reports them. A
      // company that deactivates the driver disappears from this list once the
      // account state refreshes; there is no separate "inactive" option to
      // render and no company fetched here.
      memberships={account.memberships}
      onBack={() => { router.back(); }}
    />
  );
}
