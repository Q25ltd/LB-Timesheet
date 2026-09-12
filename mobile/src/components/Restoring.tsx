/**
 * The "we are finding out whether you are signed in" placeholder.
 *
 * Shown while `AuthProvider.status` is `restoring` — a stored refresh
 * credential is being redeemed, which is a network round trip. Two places need
 * exactly this frame and must behave identically: the entry route
 * (`app/index.tsx`) and the authenticated route group's gate
 * (`app/(app)/_layout.tsx`). One copy, so a change to one cannot leave the
 * other showing something different.
 *
 * Deliberately plain. It is on screen for one round trip, and a branded splash
 * that appears for 200ms and vanishes reads as a glitch.
 *
 * It is a HOLD, never a destination: whatever renders it must redirect once
 * the provider settles. A placeholder with no exit is the defect the `(app)`
 * gate was added to remove.
 */
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { colors, spacing, typography } from "../theme/index";

export function Restoring() {
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
