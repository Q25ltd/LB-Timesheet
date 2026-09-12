/**
 * The Home route. Wiring only: the screen owns the rendering, the auth
 * provider owns the session, and this file connects them and navigates —
 * the same shape every other route has.
 *
 * It carries no "account is null" placeholder. `(app)/_layout.tsx` holds while
 * the session is restoring and redirects a signed-out driver to sign-in, so
 * this route is only ever reached with a live session.
 */
import { router } from "expo-router";
import { HomeScreen } from "../../src/screens/HomeScreen";
import { useAuth } from "../../src/auth/AuthContext";

export default function TodayRoute() {
  const {
    account, biometrics, biometricUnlockEnabled, enableBiometricUnlock,
  } = useAuth();

  // The gate renders this route only when the provider is `authenticated`, and
  // `account` is set in the same update as that status. A null here would be a
  // wiring defect rather than a driver state, so it renders nothing instead of
  // inventing an account — and the gate, not this line, is what a signed-out
  // driver actually meets.
  if (account === null) return null;

  return (
    <HomeScreen
      user={account.user}
      biometrics={biometrics}
      biometricUnlockEnabled={biometricUnlockEnabled}
      onEnableBiometrics={enableBiometricUnlock}
      // Sign out moved to Settings, which the badge opens. `navigate` rather
      // than `replace`: these are sibling tabs, not a stack to rewrite.
      onOpenAccount={() => { router.navigate("/settings"); }}
    />
  );
}
