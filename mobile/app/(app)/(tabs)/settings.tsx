/**
 * The Settings tab. Wiring only: the screen owns the rendering, the auth
 * provider owns the session, and this file connects them and navigates.
 *
 * Every capability it passes down already existed — this route is where they
 * became reachable, not where they were built.
 */
import { router } from "expo-router";
import { SettingsScreen } from "../../../src/screens/SettingsScreen";
import { useAuth } from "../../../src/auth/AuthContext";

/** A failed cleanup is shown, with its retry, on Sign-in (D61) — not dropped. */
function cleanupShownOnSignIn(): undefined {
  return undefined;
}

export default function SettingsRoute() {
  const {
    account, signOut, biometrics, biometricUnlockEnabled,
    enableBiometricUnlock, disableBiometricUnlock,
  } = useAuth();

  // The `(app)` gate renders this route only when the provider is
  // authenticated, and `account` is set in the same update as that status. A
  // null here would be a wiring defect rather than a driver state.
  if (account === null) return null;

  return (
    <SettingsScreen
      user={account.user}
      biometrics={biometrics}
      biometricUnlockEnabled={biometricUnlockEnabled}
      onEnableBiometrics={enableBiometricUnlock}
      onDisableBiometrics={disableBiometricUnlock}
      // The auth gate redirects immediately. Cleanup errors remain visible
      // on Sign-in, where they can be retried without restoring the account.
      onSignOut={() => { void signOut().finally(() => { router.replace("/sign-in"); }).catch(cleanupShownOnSignIn); }}
    />
  );
}
