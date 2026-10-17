/**
 * One finished day, as a row that opens it — the same row on Home's Recent
 * Timesheets and on the Timesheets tab, so a driver learns it once.
 *
 * Enough to recognise the day and nothing more: the date it started (the
 * date it is filed under, D18), who it was worked for, its hours and length,
 * and a Night Out marker only when there was one. Everything else is on the
 * day's own page. The row opens its day by id — never by date, employer or
 * position in the list.
 */
import { View, Text, Pressable, StyleSheet } from "react-native";
import { effectiveFacts, type CompletedShift, type WorkingContext } from "../shift/localShift";
import { formatDate, formatDuration, formatShiftHours } from "./format";
import { formStyles } from "./vehicleForm";
import { colors, spacing } from "../theme/index";
import type { SubmissionStatus } from "../sync/submissionStatus";

/** Who a day was worked for, as the driver chose it — at Start Shift, or in a correction. */
export function workingForLabel(workingFor: WorkingContext): string {
  return workingFor.kind === "personal" ? "Personal" : workingFor.companyName;
}

export function TimesheetRow({ shift, testID, last, onOpen, status = null }: {
  shift: CompletedShift; testID: string; last: boolean; onOpen: (id: string) => void;
  /** Where its sending stands (D66 S6) — `null` while sending is off, and for a Personal day. */
  status?: SubmissionStatus | null;
}) {
  // What the day says NOW — its latest correction, or the day as finished.
  const facts = effectiveFacts(shift);
  const date = formatDate(facts.startedAt);
  const hours = formatShiftHours(facts.startedAt, facts.endedAt);
  const duration = formatDuration(facts.startedAt, facts.endedAt);
  const workingFor = workingForLabel(facts.workingFor);
  return (
    <Pressable
      testID={testID}
      onPress={() => { onOpen(shift.id); }}
      accessibilityRole="button"
      accessibilityLabel={`${date}, ${workingFor}, ${hours}, ${duration}${facts.nightOut ? ", night out" : ""}${status === null ? "" : `, ${status.label}`}`}
      accessibilityHint="Opens this timesheet"
      style={({ pressed }) => [styles.row, last ? null : formStyles.optionDivided, pressed ? formStyles.optionPressed : null]}
    >
      <View style={styles.text}>
        <View style={styles.top}>
          <Text style={styles.date} testID={`${testID}-date`}>{date}</Text>
          {facts.nightOut ? <Text style={styles.nightOut} testID={`${testID}-night-out`}>Night out</Text> : null}
        </View>
        <Text style={styles.workingFor} testID={`${testID}-working-for`}>{workingFor}</Text>
        <Text style={styles.hours} testID={`${testID}-hours`}>{`${hours} · ${duration}`}</Text>
        {status === null ? null : (
          <Text style={[styles.status, status.actionNeeded ? styles.statusAction : null]} testID={`${testID}-status`}>{status.label}</Text>
        )}
      </View>
      <View style={styles.chevron} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 64,
    paddingVertical: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg + spacing.xs,
  },
  text: { flex: 1, gap: 2 },
  top: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  date: { fontSize: 16, fontWeight: "800", color: colors.text },
  nightOut: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.brandDark,
    backgroundColor: colors.surfaceAccent,
    borderRadius: 6,
    overflow: "hidden",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  // Wraps rather than truncates: a company is named in full (owner correction).
  workingFor: { fontSize: 15, color: colors.text },
  hours: { fontSize: 14, color: colors.textMuted },
  status: { fontSize: 13, fontWeight: "700", color: colors.brandDark },
  statusAction: { color: colors.danger },
  chevron: {
    width: 10,
    height: 10,
    borderRightWidth: 2.5,
    borderTopWidth: 2.5,
    borderColor: colors.textMuted,
    transform: [{ rotate: "45deg" }],
  },
});
