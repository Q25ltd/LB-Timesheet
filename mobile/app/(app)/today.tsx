/**
 * The authenticated destination for a driver with NO company (D21).
 *
 * The point of this screen in this increment is what it does NOT do. There
 * is no "join a company" gate, no "no membership" error, no blocking empty
 * state — a driver with zero memberships has a complete, working account and
 * this screen says so plainly. It also says, honestly, that the daily
 * workflow is not built yet, rather than presenting controls that do nothing.
 *
 * Personal Timesheets are NOT here and are not implied — that is a separate,
 * later product decision with its own storage model.
 */
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { BrandLockup } from "../../src/components/Brand";
import { useAuth } from "../../src/auth/AuthContext";
import { colors, spacing, typography } from "../../src/theme/index";

export default function Today() {
  const insets = useSafeAreaInsets();
  const { account, signOut } = useAuth();

  if (account === null) {
    // Reached only by deep link before a session exists.
    return <Redirecting />;
  }

  const hasCompany = account.memberships.length > 0;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.xl, paddingHorizontal: spacing.xl }}
    >
      <BrandLockup />

      <Text style={typography.title} testID="greeting">
        {`Hello, ${account.user.firstName}`}
      </Text>
      <Text style={[typography.subtitle, styles.subtitle]}>{account.user.email}</Text>

      <View style={styles.card} testID="company-state">
        <Text style={styles.cardTitle}>
          {hasCompany ? "Your companies" : "No company linked"}
        </Text>
        <Text style={typography.helper}>
          {hasCompany
            ? account.memberships.map(membership => membership.companyName).join(", ")
            : "Your account is ready. You can be linked to a haulage company later — nothing is missing until then."}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Not built yet</Text>
        <Text style={typography.helper}>
          Starting a shift, vehicle checks, finishing and submitting a timesheet are
          still to come. Nothing on this screen is a working daily workflow.
        </Text>
      </View>

      <Pressable onPress={() => { void signOut().then(() => { router.replace("/register"); }); }} accessibilityRole="button" hitSlop={8}>
        <Text style={styles.link}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

function Redirecting() {
  return (
    <View style={styles.centred}>
      <Text style={typography.helper}>Signing you in…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  centred: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  subtitle: { marginBottom: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  cardTitle: { fontSize: 17, fontWeight: "700", color: colors.brandDark },
  link: { color: colors.brandLight, fontWeight: "700", fontSize: 16, textAlign: "center", marginTop: spacing.lg },
});
