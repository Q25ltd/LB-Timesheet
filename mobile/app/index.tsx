/**
 * The entry point: authenticated drivers go to the app, everyone else
 * registers.
 *
 * Note what is NOT here — no branch on whether the driver has a company.
 * Zero memberships is a fully authenticated state and routes exactly like
 * any other (D21).
 */
import { Redirect } from "expo-router";
import { useAuth } from "../src/auth/AuthContext";

export default function Index() {
  const { isAuthenticated } = useAuth();
  return <Redirect href={isAuthenticated ? "/today" : "/register"} />;
}
