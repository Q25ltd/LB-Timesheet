/**
 * The entry point, and the ONLY place the signed-out default is decided.
 *
 *   restoring        → hold. Render nothing but a quiet placeholder.
 *   authenticated    → the app (Today)
 *   unauthenticated  → SIGN IN (owner decision, 2026-09-11)
 *
 * A signed-out launch resolves to `/sign-in`, not `/register`: most launches
 * are a returning driver, so registration was the wrong default the moment
 * login existed. Registration is one tap away, and back again.
 *
 * THE `restoring` BRANCH IS THE IMPORTANT ONE. A refresh credential in
 * SecureStore is redeemed at startup, which is a network round trip. With a
 * boolean `isAuthenticated`, that moment reads as "not authenticated" and the
 * driver is sent to Sign-in and then bounced to Today — a visible flash that
 * also teaches them their session did not survive. Holding here removes it,
 * and the hold is bounded by the API client's own request timeout.
 *
 * Note what is NOT here: no branch on whether the driver has a company. Zero
 * memberships is a fully authenticated state and routes exactly like any
 * other (D21).
 */
import { Redirect } from "expo-router";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { colors, spacing, typography } from "../src/theme/index";

export default function Index() {
  const { status } = useAuth();

  if (status === "restoring") return <Restoring />;
  return <Redirect href={status === "authenticated" ? "/today" : "/sign-in"} />;
}

/**
 * Deliberately plain. It is on screen for one round trip, and a branded
 * splash that appears for 200ms and vanishes reads as a glitch.
 */
function Restoring() {
  return (
    <View style={styles.screen} testID="auth-restoring">
      <ActivityIndicator color={colors.brandDark} />
      <Text style={typography.helper}>Signing you in…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    backgroundColor: colors.background,
  },
});
