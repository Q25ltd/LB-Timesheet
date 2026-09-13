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
      // Unchanged semantics: the server is asked first while the token is
      // still valid, and the device is cleared either way.
      onSignOut={() => { void signOut().then(() => { router.replace("/sign-in"); }); }}
    />
  );
}
