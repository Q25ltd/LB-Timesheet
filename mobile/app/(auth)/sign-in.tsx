/**
 * The sign-in route. Wiring only: the screen owns the form, the auth provider
 * owns the session, and this file connects them and navigates.
 *
 * The biometric action is passed down ONLY when this device is genuinely
 * eligible — hardware present and enrolled, the driver opted in, and the last
 * restore attempt stopped at the biometric gate rather than for some other
 * reason. Anything less and the control is not rendered: a biometric button
 * that cannot work is worse than none.
 *
 * Note what this file does NOT do: it never inspects a token and never decides
 * that anyone is authenticated. `unlock()` asks the provider to gate on the OS
 * and then let the SERVER validate the session (D26).
 */
import { router } from "expo-router";
import { SignInScreen } from "../../src/screens/SignInScreen";
import { useAuth } from "../../src/auth/AuthContext";
import type { AuthenticatedAccount } from "../../src/api/account";

export default function SignInRoute() {
  const { signIn, unlock, biometrics, biometricUnlockEnabled, restoreOutcome } = useAuth();

  // "biometric-locked" means a credential IS stored and the gate is what
  // stopped us — so offering to try again is honest. After "expired" the
  // credential has been deleted and only a password can help; after "offline"
  // the problem is the network, not the driver's face.
  const eligible = biometrics.available && biometricUnlockEnabled && restoreOutcome === "biometric-locked";

  return (
    <SignInScreen
      onSignedIn={async (account: AuthenticatedAccount) => {
        await signIn(account);
        // `replace`, not `push`: sign-in is complete and the back gesture
        // must not return a signed-in driver to the credentials form.
        router.replace("/today");
      }}
      onCreateAccount={() => {
        // `replace`, not `push`: sign-in is the signed-out DEFAULT (see
        // `app/index.tsx`), so the two auth screens replace one another and
        // the stack never holds both.
        router.replace("/register");
      }}
      {...(eligible ? { biometricUnlock: { label: biometrics.label, unlock } } : {})}
    />
  );
}
