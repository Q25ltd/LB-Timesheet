/**
 * Sign in — NOT IMPLEMENTED, and visibly so.
 *
 * Login is the next increment. This screen exists so the "Already have an
 * account?" link in the reference design has somewhere honest to go during
 * development, and it deliberately has NO email field, NO password field and
 * NO submit control: a form that looks real and silently does nothing is
 * worse than no form, because it teaches a tester that login is broken
 * rather than absent.
 */
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { BrandLockup } from "../../src/components/Brand";
import { colors, spacing, typography } from "../../src/theme/index";

export default function SignInPlaceholder() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom }]}>
      <BrandLockup />
      <View style={styles.notice} testID="sign-in-not-implemented">
        <Text style={styles.noticeTitle}>Sign in is not built yet</Text>
        <Text style={typography.helper}>
          Registration is the current increment. Signing in with an existing account
          arrives next — there is no login API to call yet, so nothing here would work.
        </Text>
      </View>
      <Pressable onPress={() => { router.back(); }} accessibilityRole="button" hitSlop={8}>
        <Text style={styles.link}>Back to create account</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.xl, gap: spacing.xl },
  notice: {
    backgroundColor: "#FFF6E5",
    borderColor: "#E4B95B",
    borderWidth: 1,
    borderRadius: spacing.md,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  noticeTitle: { fontSize: 17, fontWeight: "700", color: "#7A5A12" },
  link: { color: colors.brandLight, fontWeight: "700", fontSize: 16, textAlign: "center" },
});
