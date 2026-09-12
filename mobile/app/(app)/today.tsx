/**
 * The Home route. Wiring only: the screen owns the rendering, the auth
 * provider owns the session, and this file connects them and navigates —
 * the same shape both auth routes have.
 *
 * It no longer carries an "account is null" placeholder. `(app)/_layout.tsx`
 * now holds while the session is restoring and redirects a signed-out driver
 * to sign-in, so this route is only ever reached with a live session.
 */
import { router } from "expo-router";
import { HomeScreen } from "../../src/screens/HomeScreen";
import { useAuth } from "../../src/auth/AuthContext";

export default function TodayRoute() {
  const {
    account, signOut, biometrics, biometricUnlockEnabled, enableBiometricUnlock,
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
      // `signOut` revokes the SERVER session first and clears the device
      // either way, so a driver with no signal is still signed out locally.
      // Then SIGN-IN, not registration — they still have an account.
      onSignOut={() => { void signOut().then(() => { router.replace("/sign-in"); }); }}
    />
  );
}
