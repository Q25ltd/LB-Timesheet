/**
 * The LogisticBay Timesheets lockup, and the hero photograph beneath the form.
 */
import { Image, View, Text, StyleSheet } from "react-native";
import registrationHero from "../../assets/images/registration-truck-sunrise.png";
import { spacing, typography } from "../theme/index";

export function BrandLockup() {
  return (
    <View style={styles.lockup} accessibilityRole="header">
      <Text style={typography.wordmark}>LogisticBay</Text>
      <Text style={typography.lockup}>TIMESHEETS</Text>
    </View>
  );
}

/**
 * The full-bleed hero.
 *
 * It is rendered as a SIBLING of the padded form, never inside it. The
 * previous version lived inside the form's horizontally-padded container and
 * cancelled that padding with `marginHorizontal: -24` — a full-bleed trick
 * that only works if every ancestor's width is exactly the screen's. It
 * wasn't, so the image sat short of the right edge and left a white strip.
 *
 * Here the parent is already edge-to-edge, so the image simply fills it and
 * there is no padding to cancel and nothing to get out of step.
 *
 * `flexShrink` with `minHeight: 0` is what makes it adapt: on a tall phone it
 * takes its natural aspect ratio, and on a short one it gives its space to
 * the form rather than pushing the form off-screen.
 */
export function BrandHero() {
  return (
    <View style={styles.hero} accessible={false} testID="brand-hero">
      <Image source={registrationHero} style={styles.heroImage} resizeMode="cover" />
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: { alignItems: "center", gap: spacing.xs },
  hero: {
    width: "100%",
    aspectRatio: 2.25,
    flexShrink: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  // Absolute fill rather than 100%/100%: when flexShrink squeezes the
  // container below its aspect ratio, a percentage-sized child can round to
  // a hairline short of the edge. Pinning all four sides cannot.
  heroImage: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: "100%", height: "100%" },
});
