/**
 * The honest empty state for a destination whose feature is not built.
 *
 * THE LINE THIS COMPONENT EXISTS TO HOLD. A tab that leads nowhere is bad; a
 * tab that leads to a specimen of the thing it will one day show is worse. A
 * driver who sees three plausible timesheet rows will believe they are theirs,
 * and no "example data" caption survives a glance at 5am in a yard.
 *
 * So the page is real, designed and clearly labelled as unfinished, and it
 * shows NOTHING of the shape of the data it is waiting for: no rows, no
 * statuses, no dates, no totals. When the feature lands, the rows replace this
 * card and the page around it does not change.
 */
import { View, Text, StyleSheet } from "react-native";
import { TabIcon, type TabIconName } from "../components/TabIcon";
import { colors, radius, spacing, typography } from "../theme/index";

interface ComingSoonCardProps {
  icon: TabIconName;
  /** Short, and never a promise about when. */
  headline: string;
  body: string;
  testID: string;
}

export function ComingSoonCard({ icon, headline, body, testID }: ComingSoonCardProps) {
  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.icon}>
        <TabIcon name={icon} color={colors.brandLight} size={28} />
      </View>
      <Text style={styles.headline}>{headline}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.surfaceAccent,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  headline: { fontSize: 18, fontWeight: "700", color: colors.brandDark, textAlign: "center" },
  body: {
    ...typography.helper,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    marginTop: spacing.sm,
  },
});
