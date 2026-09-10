/**
 * The LogisticBay Timesheets lockup, and the reserved hero area beneath the
 * form.
 *
 * No logo mark and no photograph ship here. No approved asset exists in this
 * repository, and sourcing one from the internet is not an option — so the
 * wordmark is set in type and the hero is a neutral treatment holding the
 * exact space the approved truck photograph will occupy. Dropping the real
 * asset in later replaces `BrandHero`'s inner view and nothing else.
 */
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/index";
import { typography } from "../theme/index";

export function BrandLockup() {
  return (
    <View style={styles.lockup} accessibilityRole="header">
      <Text style={typography.wordmark}>LogisticBay</Text>
      <Text style={typography.lockup}>TIMESHEETS</Text>
    </View>
  );
}

/**
 * The lower brand area from the reference design. Fixed height so the page's
 * rhythm does not change when the real image arrives, and `accessible={false}`
 * because it carries no information a screen reader needs.
 */
export function BrandHero() {
  return (
    <View style={styles.hero} accessible={false} testID="brand-hero">
      <View style={styles.heroBand} />
      <View style={styles.heroRoad} />
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: {
    alignItems: "center",
    gap: spacing.xs,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  hero: {
    height: 132,
    marginTop: spacing.xl,
    borderRadius: radius.card,
    overflow: "hidden",
    backgroundColor: "#E8F0F9",
    justifyContent: "flex-end",
  },
  heroBand: {
    flex: 1,
    backgroundColor: "#DCE9F6",
  },
  heroRoad: {
    height: 28,
    backgroundColor: colors.brandDark,
    opacity: 0.85,
  },
});
