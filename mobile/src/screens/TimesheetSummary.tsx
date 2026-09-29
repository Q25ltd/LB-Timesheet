/**
 * A timesheet as it will be saved — the Finish Review's body, and Edit
 * Timesheet's final review before a company declaration (D41).
 *
 * A SUMMARY THAT CORRECTS. It reads as a summary — no field is an input — but
 * every driver-entered fact on it opens where it is corrected, when the
 * caller passes the way there: a shift row, a use card (by the use's
 * identity, never its plate or number), the vehicle in use's final mileage.
 * Rows and cards with nowhere to go are plain text.
 *
 * Checks not completed are named in one warning and never marked done.
 */
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { CompletedShift } from "../shift/localShift";
import { trailerTypeLabel } from "../shift/trailer";
import { usesWithoutCompletedCheck } from "../shift/checkCompletion";
import { usageDistance } from "../shift/usedVehicles";
import { CHECK_RESULT, checkStateOf, effectiveItems, latestCheck, type VehicleCheck } from "../shift/vehicleCheck";
import { FILL_TYPE, summariseFills, summariseRecords, type FillSummary } from "../shift/vehicleFill";
import {
  checkDetailLabel,
  classLabel,
  fillSummaryText,
  formatClockTime,
  formatDateTime,
  formatDuration,
  formatFinish,
  formatMileage,
  formatMileageRange,
} from "./format";
import { workingForLabel } from "./TimesheetRow";
import { FormSection, formStyles } from "./vehicleForm";
import { colors, radius, spacing, typography } from "../theme/index";

/** Where each part of the summary is corrected. Absent: that part is not offered. */
export interface SummaryCorrections {
  /** Who the day is for, and when it started. */
  onEditShift?: () => void;
  /** The finish, Night Out and notes. */
  onEditDetails?: () => void;
  /** The final mileage of the vehicle in use. */
  onEditFinalMileage?: () => void;
  /** One vehicle use, by its identity. */
  onOpenVehicle?: (useId: string) => void;
  /** One trailer use, by its identity. */
  onOpenTrailer?: (useId: string) => void;
}

export function TimesheetSummary({ day, inUse, corrections = {} }: {
  day: CompletedShift;
  /** The uses still in use in the day being finished, by `useId` — they end at the finish. */
  inUse: { vehicle: string | null; trailer: string | null };
  corrections?: SummaryCorrections;
}) {
  const unfinished = usesWithoutCompletedCheck(day).map(use => use.name);
  return (
    <>
      <View style={[formStyles.card, styles.facts]}>
        <Row label="Working for" value={workingForLabel(day.workingFor)} testID="review-working-for" onPress={corrections.onEditShift} />
        <Row label="Started" value={formatDateTime(day.startedAt)} testID="review-started" onPress={corrections.onEditShift} />
        <Row label="Finished" value={formatFinish(day.startedAt, day.endedAt)} testID="review-finished" onPress={corrections.onEditDetails} />
        <Row label="Duration" value={formatDuration(day.startedAt, day.endedAt)} testID="review-duration" />
        <Row label="Night out" value={day.nightOut ? "Yes" : "No"} testID="review-night-out" onPress={corrections.onEditDetails} />
        {day.notes === null
          ? (corrections.onEditDetails === undefined ? null : <Row label="Notes" value="Add notes" testID="review-add-notes" onPress={corrections.onEditDetails} last />)
          : <Row label="Notes" value={day.notes} testID="review-notes" onPress={corrections.onEditDetails} last />}
      </View>

      {unfinished.length > 0 ? (
        <Text style={styles.warning} testID="review-check-warning">
          {`Checks not completed: ${unfinished.join(", ")}. You can still finish.`}
        </Text>
      ) : null}

      <FormSection label="VEHICLES">
        {day.previousVehicles.length === 0 ? (
          <Text style={styles.none} testID="review-no-vehicles">No vehicle used</Text>
        ) : day.previousVehicles.map((use, index) => {
          const endsNow = inUse.vehicle === use.useId;
          return (
            <UseEntry
              key={use.useId}
              prefix={`review-vehicle-${String(index)}`}
              title={`${use.numberPlate} · ${classLabel(use.vehicleClass)}`}
              times={`${formatClockTime(use.startedAt)} – ${formatClockTime(use.endedAt)}`}
              lines={[
                { key: "mileage", text: `${formatMileageRange(use.startMileage, use.endMileage)} · ${formatMileage(usageDistance(use))}` },
                ...fillLine("fuel", "Fuel", summariseFills(use.fills, FILL_TYPE.fuel)),
                ...fillLine("adblue", "AdBlue", summariseFills(use.fills, FILL_TYPE.adblue)),
              ]}
              checks={use.checks}
              endsNow={endsNow}
              onOpen={corrections.onOpenVehicle === undefined ? undefined : () => { corrections.onOpenVehicle?.(use.useId); }}
              onFinalMileage={endsNow ? corrections.onEditFinalMileage : undefined}
              last={index === day.previousVehicles.length - 1}
            />
          );
        })}
      </FormSection>

      {day.previousTrailers.length === 0 ? null : (
        <FormSection label="TRAILERS">
          {day.previousTrailers.map((use, index) => (
            <UseEntry
              key={use.useId}
              prefix={`review-trailer-${String(index)}`}
              title={`${use.trailerNumber} · ${trailerTypeLabel(use.trailerType)}`}
              times={`${formatClockTime(use.startedAt)} – ${formatClockTime(use.endedAt)}`}
              lines={fillLine("fridge-diesel", "Fridge diesel", summariseRecords(use.reeferDiesel))}
              checks={use.checks}
              endsNow={inUse.trailer === use.useId}
              onOpen={corrections.onOpenTrailer === undefined ? undefined : () => { corrections.onOpenTrailer?.(use.useId); }}
              last={index === day.previousTrailers.length - 1}
            />
          ))}
        </FormSection>
      )}
    </>
  );
}

/** "Fuel: 350 L · 2 entries" — or no line at all when none was recorded. */
function fillLine(key: string, label: string, summary: FillSummary): { key: string; text: string }[] {
  const shown = fillSummaryText(summary);
  return shown === null ? [] : [{ key, text: `${label}: ${shown.amount} · ${shown.detail}` }];
}

/**
 * One vehicle or trailer use: what it was, when, what went into it, and its
 * check — the whole card opening the use's own page when it can be corrected.
 */
function UseEntry({ prefix, title, times, lines, checks, endsNow, onOpen, onFinalMileage, last }: {
  prefix: string; title: string; times: string; lines: { key: string; text: string }[];
  checks: readonly VehicleCheck[]; endsNow: boolean; onOpen?: () => void; onFinalMileage?: () => void; last: boolean;
}) {
  const check = latestCheck(checks);
  const completed = checkStateOf(checks) === "completed" && check !== null;
  // What the certificate says NOW — its latest correction, or the original.
  const defects = completed ? effectiveItems(check).filter(item => item.result === CHECK_RESULT.defect) : [];
  const body = (
    <View style={styles.entryBody}>
      <Text style={styles.entryTitle} testID={`${prefix}-title`}>{title}</Text>
      <Text style={styles.entryLine} testID={`${prefix}-times`}>{times}</Text>
      {endsNow ? <Text style={styles.entryNote}>In use — ends at the finish</Text> : null}
      {lines.map(line => (
        <Text key={line.key} style={styles.entryLine} testID={`${prefix}-${line.key}`}>{line.text}</Text>
      ))}
      <Text style={[styles.entryLine, completed ? null : styles.notDone]} testID={`${prefix}-checks`}>{checkDetailLabel(checks)}</Text>
      {defects.map((item, index) => (
        <Text key={item.key} style={styles.defect} testID={`${prefix}-defect-${String(index)}`}>
          {`Defect — ${item.label}: ${item.note ?? ""}`}
        </Text>
      ))}
    </View>
  );
  return (
    <View style={[styles.entry, last ? null : formStyles.optionDivided]}>
      {onOpen === undefined ? body : (
        <Pressable
          testID={`${prefix}-open`}
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`${title}. Check or correct`}
          style={({ pressed }) => [styles.openable, pressed ? formStyles.optionPressed : null]}
        >
          {body}
          <View style={styles.chevron} />
        </Pressable>
      )}
      {onFinalMileage === undefined ? null : (
        <Pressable testID={`${prefix}-final-mileage`} onPress={onFinalMileage} accessibilityRole="button" accessibilityLabel="Change final mileage" hitSlop={6} style={styles.link}>
          <Text style={styles.linkLabel}>Change final mileage</Text>
        </Pressable>
      )}
    </View>
  );
}

function Row({ label, value, testID, onPress, last = false }: { label: string; value: string; testID: string; onPress?: () => void; last?: boolean }) {
  const content = (
    <>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} testID={testID}>{value}</Text>
    </>
  );
  if (onPress === undefined) return <View style={[styles.row, last ? null : formStyles.optionDivided]}>{content}</View>;
  return (
    <Pressable
      testID={`${testID}-edit`}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}. Change`}
      style={({ pressed }) => [styles.row, last ? null : formStyles.optionDivided, pressed ? formStyles.optionPressed : null]}
    >
      {content}
      <View style={styles.chevron} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  facts: { marginBottom: spacing.xl },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  rowLabel: { fontSize: 15, color: colors.textMuted },
  rowValue: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.text, textAlign: "right" },
  warning: {
    ...typography.helper,
    color: colors.danger,
    backgroundColor: colors.dangerBg,
    borderRadius: radius.card,
    padding: spacing.md,
    marginBottom: spacing.xl,
  },
  none: { fontSize: 15, color: colors.textMuted, paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  entry: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  openable: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  entryBody: { flex: 1, gap: 2 },
  entryTitle: { fontSize: 17, fontWeight: "800", color: colors.text },
  entryLine: { fontSize: 15, color: colors.text },
  entryNote: { fontSize: 14, color: colors.textMuted },
  notDone: { color: colors.danger, fontWeight: "700" },
  defect: { fontSize: 15, color: colors.danger },
  link: { alignSelf: "flex-start", minHeight: 36, justifyContent: "center", marginTop: spacing.xs },
  linkLabel: { fontSize: 14, fontWeight: "600", color: colors.brandLight },
  chevron: {
    width: 10,
    height: 10,
    borderRightWidth: 2.5,
    borderTopWidth: 2.5,
    borderColor: colors.textMuted,
    transform: [{ rotate: "45deg" }],
  },
});
