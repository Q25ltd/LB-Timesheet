/**
 * Active Shift — proof that the day is open, and what it was started with.
 *
 * MINIMAL BY INSTRUCTION. This increment ends at the handoff: the screen shows
 * that a shift is running and, where there is one, the vehicle it began with.
 * It carries no operational actions — no checks, no Add Vehicle, no Change
 * Vehicle, no fuel, no trailer, no Finish Shift — because none of those exist
 * yet and a control that opens nothing is worse than an absent one.
 *
 * THE TWO STATES IT MUST TELL APART, because they are genuinely different
 * days: a shift running with no vehicle (booked on, truck not yet handed over)
 * and a shift running with one. The first is not an error or a half-start.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabIcon } from "../components/TabIcon";
import { VEHICLE_CLASSES, type LocalShift } from "../shift/localShift";
import { colors, radius, spacing, typography } from "../theme/index";

function classLabel(id: string): string {
  return VEHICLE_CLASSES.find(option => option.id === id)?.label ?? id;
}

/** The declared start, as a plain clock time. */
function startedTime(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function ActiveShiftScreen({ shift }: { shift: LocalShift }) {
  const insets = useSafeAreaInsets();
  const { vehicle } = shift;

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl },
        ]}
      >
        <Text style={styles.title} testID="screen-title" accessibilityRole="header">Active Shift</Text>

        <View style={styles.card} testID="shift-running">
          <View style={styles.icon}>
            <TabIcon name="clock" color={colors.brandLight} size={26} />
          </View>
          <Text style={styles.headline}>Shift started</Text>
          <Text style={styles.detail} testID="shift-started-at">{`Started at ${startedTime(shift.startedAt)}`}</Text>
          <Text style={styles.detail} testID="shift-working-for">
            {shift.workingFor.kind === "personal" ? "Personal" : shift.workingFor.companyName}
          </Text>
        </View>

        {vehicle === null ? (
          <View style={styles.card} testID="no-vehicle">
            <Text style={styles.headline}>No vehicle yet</Text>
            <Text style={styles.detail}>
              You&apos;ve booked on without a vehicle. Adding one is coming in a later update.
            </Text>
          </View>
        ) : (
          <View style={styles.card} testID="active-vehicle">
            <Text style={styles.headline}>Vehicle</Text>
            <Row label="Class" value={classLabel(vehicle.vehicleClass)} valueTestID="vehicle-class-value" />
            <Row label="Number plate" value={vehicle.numberPlate} valueTestID="vehicle-plate-value" />
            <Row label="Start mileage" value={String(vehicle.startMileage)} valueTestID="vehicle-mileage-value" />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Row({ label, value, valueTestID }: { label: string; value: string; valueTestID: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} testID={valueTestID}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, paddingHorizontal: spacing.xl },
  title: { ...typography.title, marginBottom: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    marginBottom: spacing.lg,
  },
  icon: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: colors.surfaceAccent,
    alignItems: "center", justifyContent: "center",
    marginBottom: spacing.md,
  },
  headline: { fontSize: 19, fontWeight: "700", color: colors.brandDark },
  detail: { ...typography.helper, fontSize: 15, lineHeight: 21, marginTop: spacing.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
    marginTop: spacing.md,
  },
  rowLabel: { fontSize: 15, color: colors.textMuted },
  rowValue: { flexShrink: 1, fontSize: 16, fontWeight: "700", color: colors.text, textAlign: "right" },
});
