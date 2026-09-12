/**
 * The authenticated app's bottom navigation.
 *
 * A custom bar rather than the navigator's default, for one reason that
 * matters: the design is the owner's, and the default bar's typography,
 * spacing and active treatment are the library's. Routing is still the
 * navigator's job — this component only says which destination is current and
 * which one was pressed, which is also what makes it testable without a
 * navigation tree.
 *
 * `APP_TABS` is the single source of truth it draws from, shared with the
 * layout that registers the routes, so a control here cannot point at a
 * destination the app does not have.
 *
 * The bottom safe-area inset is padding INSIDE the bar rather than a margin
 * under it, so the bar's surface reaches the bottom of the screen on a phone
 * with a home indicator instead of leaving a strip of background beneath it.
 */
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabIcon } from "../components/TabIcon";
import { APP_TABS } from "./tabs";
import { colors, sizing, spacing } from "../theme/index";

interface AppTabBarProps {
  /** The route currently showing — the navigator's, never this bar's own state. */
  activeRouteName: string;
  onSelect: (routeName: string) => void;
}

export function AppTabBar({ activeRouteName, onSelect }: AppTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}
      accessibilityRole="tablist"
      testID="app-tab-bar"
    >
      {APP_TABS.map(tab => {
        const active = tab.name === activeRouteName;
        return (
          <Pressable
            key={tab.name}
            testID={`tab-${tab.name}`}
            onPress={() => { onSelect(tab.name); }}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            // `selected` is what a screen reader announces, and it is read from
            // the route rather than from anything this component remembers.
            accessibilityState={{ selected: active }}
            style={styles.tab}
          >
            <TabIcon name={tab.icon} color={active ? colors.brandLight : colors.textMuted} />
            <Text
              style={[styles.label, active ? styles.labelActive : null]}
              numberOfLines={1}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  // `flex: 1` rather than a fixed width: four equal columns on any phone,
  // and the labels below stay centred under their icons at every size.
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    minHeight: sizing.minTouch,
    paddingHorizontal: spacing.xs,
  },
  label: { fontSize: 11, fontWeight: "600", color: colors.textMuted },
  labelActive: { color: colors.brandLight, fontWeight: "700" },
});
