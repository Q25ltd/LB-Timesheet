/**
 * The frame every authenticated page that is not Home sits in.
 *
 * Three screens need the same thing — the status-bar inset, one title in the
 * same place at the same size, a scrollable body, and room at the bottom so
 * content never finishes underneath the tab bar. Writing that three times is
 * how the three drift apart, and the drift shows up as a title that moves
 * when you switch tabs.
 *
 * Home is deliberately NOT built on this: it has its own header composition
 * (brand lockup and identity badge on one row) and no page title, because the
 * greeting is its heading.
 */
import type { ReactNode } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, spacing, typography } from "../theme/index";

interface AppScreenProps {
  title: string;
  children: ReactNode;
}

export function AppScreen({ title, children }: AppScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          // The navigator lays the scene above the tab bar, so the bottom
          // inset is already handled there; this is breathing room, not a
          // clearance hack.
          { paddingTop: insets.top + spacing.lg, paddingBottom: spacing.xxl },
        ]}
      >
        <Text style={styles.title} testID="screen-title" accessibilityRole="header">{title}</Text>
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, paddingHorizontal: spacing.xl },
  title: { ...typography.title, marginBottom: spacing.lg },
});
