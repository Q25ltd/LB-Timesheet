/**
 * The registration route. Wiring only: the screen owns the form, the auth
 * provider owns the session, and this file connects them and navigates.
 */
import { router } from "expo-router";
import { RegisterScreen } from "../../src/screens/RegisterScreen";
import { useAuth } from "../../src/auth/AuthContext";
import type { AuthenticatedAccount } from "../../src/api/account";

export default function RegisterRoute() {
  const { signIn } = useAuth();

  return (
    <RegisterScreen
      onRegistered={async (account: AuthenticatedAccount) => {
        await signIn(account);
        // `replace`, not `push`: registration is complete and the back
        // gesture must not return a signed-in driver to the sign-up form.
        router.replace("/today");
      }}
      // `replace`, not `push`: sign-in is now the signed-out DEFAULT and
      // registration is reached from it by replacement, so pushing would
      // stack a second auth screen and leave a back gesture that cycles
      // between the two.
      onSignIn={() => { router.replace("/sign-in"); }}
    />
  );
}
