/**
 * The registration route. Wiring only: the screen owns the form, the auth
 * provider owns the session, and this file connects them and navigates.
 */
import { router } from "expo-router";
import { RegisterScreen } from "../../src/screens/RegisterScreen";
import { useAuth } from "../../src/auth/AuthContext";
import type { RegistrationResponse } from "../../src/api/registration";

export default function RegisterRoute() {
  const { signInFromRegistration } = useAuth();

  return (
    <RegisterScreen
      onRegistered={async (response: RegistrationResponse) => {
        await signInFromRegistration(response);
        // `replace`, not `push`: registration is complete and the back
        // gesture must not return a signed-in driver to the sign-up form.
        router.replace("/today");
      }}
      onSignIn={() => { router.push("/sign-in"); }}
    />
  );
}
