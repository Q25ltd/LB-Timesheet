/**
 * One finished day, as it was recorded. Read-only.
 *
 * A faithful rendering of the stored `CompletedShift` (D38) and nothing
 * else: the shift, then every vehicle use and every trailer use in the order
 * they happened — each its own entry, so the same plate or trailer used twice
 * is two entries, each with its own mileage, fills, check and defects.
 *
 * CHECKS say exactly what is stored. A completed check shows what its
 * certificate says NOW — its latest correction, or the original — and says it
 * was corrected; the original and every revision stay in the record beneath
 * it. A draft is not a check: it says not completed, and then shows the rows
 * the driver actually changed, marked as draft and uncertified — never the
 * untouched rows, which were never answered and are not results. Nothing is
 * marked done, and defects stay on the use and check they were found on.
 *
 * READ-ONLY UNTIL THE DRIVER CHOOSES (D39). The page shows what the day says
 * NOW — its latest correction — and says when it was corrected, with the
 * history one press away. Edit Timesheet corrects the day's own facts; each
 * use opens its own page, by its identity, for its fills, mileage and check;
 * Delete Timesheet asks first, and names what it removes.
 *
 * A COMPANY'S DAY SAYS WHEN IT NEEDS DECLARING (D42), and only what can be
 * proven: with no valid declaration — none recorded, or one damaged — it
 * needs review and confirmation; with a valid declaration of another version
 * — a use's fill, mileage, check or times changed — it has changed since the
 * driver confirmed it. Either way it offers the Review to confirm it.
 */
import { useState } from "react";
import { View, Text, ScrollView, Pressable, Alert, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { declarationState, effectiveFacts, effectiveUses, type CompletedShift, type EndedVehicle, type ShiftFacts } from "../shift/localShift";
import { USE_ENDED_BY } from "../shift/useEnd";
import { TRAILER_TYPE, trailerTypeLabel, type EndedTrailer } from "../shift/trailer";
import { usageDistance } from "../shift/usedVehicles";
import { CHECK_RESULT, checkStateOf, effectiveItems, latestCheck, type CheckResult, type VehicleCheck } from "../shift/vehicleCheck";
import { FILL_TYPE, fillsOfType, type FillRecord } from "../shift/vehicleFill";
import {
  calendarDaysBetween,
  classLabel,
  finishedCheckLabel,
  formatClockTime,
  formatDate,
  formatDateTime,
  formatDuration,
  formatFinish,
  formatLitres,
  formatMileage,
} from "./format";
import { workingForLabel } from "./TimesheetRow";
import { BackButton, FormSection, formStyles } from "./vehicleForm";
import { colors, spacing } from "../theme/index";

interface TimesheetActions {
  /** Correct the day's own facts. */
  onEdit: () => void;
  /** Review a company's day changed since it was declared, and declare it again (D42). */
  onReview: () => void;
  /** Delete the day — called ONLY after the driver confirms. */
  onDelete: () => void;
  /** Open one vehicle use, by its identity. */
  onOpenVehicleUse: (useId: string) => void;
  /** Open one trailer use, by its identity. */
  onOpenTrailerUse: (useId: string) => void;
  /** Open, complete or correct one vehicle use's check. */
  onVehicleCheck: (useId: string) => void;
  /** Open, complete or correct one trailer use's check. */
  onTrailerCheck: (useId: string) => void;
}

interface TimesheetDetailScreenProps extends TimesheetActions {
  /** The finished day — or `null` when no readable day has the id asked for. */
  shift: CompletedShift | null;
  onBack: () => void;
}

export function TimesheetDetailScreen({ shift, onBack, ...actions }: TimesheetDetailScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={formStyles.screen}>
      <ScrollView
        testID="timesheet-scroll"
        style={formStyles.screen}
        contentContainerStyle={[
          formStyles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
      >
        <BackButton testID="timesheet-back" onPress={onBack} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">Timesheet</Text>
        {shift === null ? (
          <Text style={styles.missing} testID="timesheet-missing">
            This timesheet can't be found on this phone.
          </Text>
        ) : <Day shift={shift} actions={actions} />}
      </ScrollView>
    </View>
  );
}

/** What a company's day says about its declaration — only what can be proven (D42). */
const UNCONFIRMED: Record<ReturnType<typeof declarationState>, string | null> = {
  "not-required": null,
  confirmed: null,
  unconfirmed: "This timesheet needs review and confirmation.",
  changed: "This timesheet has changed since you confirmed it.",
};

function Day({ shift, actions }: { shift: CompletedShift; actions: TimesheetActions }) {
  // What the day says NOW; the day as finished stays in the record beneath it.
  const facts = effectiveFacts(shift);
  // Uses as the day says them now: one the finish ended ends at the finish (D40).
  const uses = effectiveUses(shift);
  const corrections = shift.corrections ?? [];
  const latest = corrections[corrections.length - 1];
  const unconfirmedText = UNCONFIRMED[declarationState(shift)];

  function askToDelete() {
    Alert.alert("Delete this timesheet?", "This removes the local timesheet from this phone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete Timesheet", style: "destructive", onPress: actions.onDelete },
    ]);
  }

  return (
    <>
      <FormSection label="SHIFT">
        <Row label="Date" value={formatDate(facts.startedAt)} testID="timesheet-date" />
        <Row label="Working for" value={workingForLabel(facts.workingFor)} testID="timesheet-working-for" />
        <Row label="Started" value={formatDateTime(facts.startedAt)} testID="timesheet-started" />
        <Row label="Finished" value={formatFinish(facts.startedAt, facts.endedAt)} testID="timesheet-finished" />
        <Row label="Duration" value={formatDuration(facts.startedAt, facts.endedAt)} testID="timesheet-duration" />
        <Row label="Night out" value={facts.nightOut ? "Yes" : "No"} testID="timesheet-night-out" last={facts.notes === null} />
        {facts.notes === null ? null : <Row label="Notes" value={facts.notes} testID="timesheet-notes" last stacked />}
      </FormSection>
      {latest === undefined ? null : <History shift={shift} lastCorrectedAt={latest.correctedAt} />}
      {unconfirmedText === null ? null : (
        <View style={styles.unconfirmed}>
          <Text style={styles.unconfirmedText} testID="timesheet-unconfirmed">{unconfirmedText}</Text>
          <Pressable
            testID="timesheet-review"
            onPress={actions.onReview}
            accessibilityRole="button"
            accessibilityLabel="Review and Confirm"
            style={({ pressed }) => [styles.edit, pressed ? formStyles.optionPressed : null]}
          >
            <Text style={styles.editLabel}>Review and Confirm</Text>
          </Pressable>
        </View>
      )}

      <FormSection label="VEHICLES">
        {uses.previousVehicles.length === 0 ? (
          <Text style={styles.none} testID="timesheet-no-vehicles">No vehicle used</Text>
        ) : uses.previousVehicles.map((use, index) => (
          <VehicleUse
            key={use.useId} use={use} facts={facts} prefix={`timesheet-vehicle-${String(index)}`} last={index === uses.previousVehicles.length - 1}
            onOpen={() => { actions.onOpenVehicleUse(use.useId); }} onCheck={() => { actions.onVehicleCheck(use.useId); }}
          />
        ))}
      </FormSection>

      {uses.previousTrailers.length === 0 ? null : (
        <FormSection label="TRAILERS">
          {uses.previousTrailers.map((use, index) => (
            <TrailerUse
              key={use.useId} use={use} facts={facts} prefix={`timesheet-trailer-${String(index)}`} last={index === uses.previousTrailers.length - 1}
              onOpen={() => { actions.onOpenTrailerUse(use.useId); }} onCheck={() => { actions.onTrailerCheck(use.useId); }}
            />
          ))}
        </FormSection>
      )}

      <View style={styles.actions}>
        <Pressable
          testID="timesheet-edit"
          onPress={actions.onEdit}
          accessibilityRole="button"
          accessibilityLabel="Edit Timesheet"
          style={({ pressed }) => [styles.edit, pressed ? formStyles.optionPressed : null]}
        >
          <Text style={styles.editLabel}>Edit Timesheet</Text>
        </Pressable>
        <Pressable
          testID="timesheet-delete"
          onPress={askToDelete}
          accessibilityRole="button"
          accessibilityLabel="Delete Timesheet"
          hitSlop={8}
          style={styles.delete}
        >
          <Text style={styles.deleteLabel}>Delete Timesheet</Text>
        </Pressable>
      </View>
    </>
  );
}

/**
 * "Working for: Personal → Northgate Haulage" — what one correction changed,
 * including the uses the day's finish ended, which moved with it (D40).
 */
function changes(before: ShiftFacts, after: ShiftFacts, closedByFinish: readonly string[]): string[] {
  const lines: string[] = [];
  const who = (facts: ShiftFacts) => workingForLabel(facts.workingFor);
  if (who(before) !== who(after) || JSON.stringify(before.workingFor) !== JSON.stringify(after.workingFor)) lines.push(`Working for: ${who(before)} → ${who(after)}`);
  if (before.startedAt !== after.startedAt) lines.push(`Started: ${formatDateTime(before.startedAt)} → ${formatDateTime(after.startedAt)}`);
  if (before.endedAt !== after.endedAt) {
    lines.push(`Finished: ${formatDateTime(before.endedAt)} → ${formatDateTime(after.endedAt)}`);
    if (closedByFinish.length > 0) lines.push(`${closedByFinish.join(" and ")} ${closedByFinish.length === 1 ? "ends" : "end"} with the finish`);
  }
  if (before.nightOut !== after.nightOut) lines.push(`Night out: ${before.nightOut ? "Yes" : "No"} → ${after.nightOut ? "Yes" : "No"}`);
  if (before.notes !== after.notes) lines.push(after.notes === null ? "Notes removed" : before.notes === null ? "Notes added" : "Notes edited");
  return lines;
}

/**
 * That the day was corrected, and when — and, one press away, what it said
 * when finished and what each correction changed. Nothing is rewritten.
 */
function History({ shift, lastCorrectedAt }: { shift: CompletedShift; lastCorrectedAt: string }) {
  const [open, setOpen] = useState(false);
  const corrections = shift.corrections ?? [];
  const asFinished: ShiftFacts = { workingFor: shift.workingFor, startedAt: shift.startedAt, endedAt: shift.endedAt, nightOut: shift.nightOut, notes: shift.notes };
  const closedByFinish = [
    ...shift.previousVehicles.filter(use => use.endedBy === USE_ENDED_BY.finish).map(use => use.numberPlate),
    ...shift.previousTrailers.filter(use => use.endedBy === USE_ENDED_BY.finish).map(use => `trailer ${use.trailerNumber}`),
  ];
  return (
    <View style={styles.history}>
      <Text style={styles.corrected} testID="timesheet-corrected">{`Corrected · last ${formatDateTime(lastCorrectedAt)}`}</Text>
      <Pressable
        testID="timesheet-history-toggle"
        onPress={() => { setOpen(!open); }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={8}
      >
        <Text style={styles.historyToggle}>{open ? "Hide correction history" : "Show correction history"}</Text>
      </Pressable>
      {open ? (
        <View style={[formStyles.card, styles.historyCard]} testID="timesheet-history">
          <View style={[styles.historyEntry, formStyles.optionDivided]} testID="timesheet-history-original">
            <Text style={styles.historyTitle}>{`As finished · ${formatDateTime(shift.endedAt)}`}</Text>
            <Text style={styles.entryNote}>{`${workingForLabel(asFinished.workingFor)} · ${formatDateTime(asFinished.startedAt)} → ${formatDateTime(asFinished.endedAt)} · Night out ${asFinished.nightOut ? "Yes" : "No"}`}</Text>
          </View>
          {corrections.map((correction, index) => (
            <View key={correction.id} style={[styles.historyEntry, index === corrections.length - 1 ? null : formStyles.optionDivided]} testID={`timesheet-history-${String(index)}`}>
              <Text style={styles.historyTitle}>{`Corrected · ${formatDateTime(correction.correctedAt)}`}</Text>
              {changes(index === 0 ? asFinished : (corrections[index - 1] ?? asFinished), correction, closedByFinish).map(line => (
                <Text key={line} style={styles.entryNote}>{line}</Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A time within the day: the clock alone on the day it started, the date too on any later one. */
function onTheDay(facts: ShiftFacts, iso: string): string {
  return calendarDaysBetween(facts.startedAt, iso) === 0 ? formatClockTime(iso) : formatDateTime(iso);
}

/** A use's title, pressable to open its own page; and its check action. */
function UseHeader({ prefix, title, onOpen }: { prefix: string; title: string; onOpen: () => void }) {
  return (
    <Pressable
      testID={`${prefix}-open`}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${title}. Opens this use`}
      style={({ pressed }) => [styles.useHeader, pressed ? formStyles.optionPressed : null]}
    >
      <Text style={styles.useTitle} testID={`${prefix}-title`}>{title}</Text>
      <Text style={styles.openLabel}>Open</Text>
    </Pressable>
  );
}

function CheckAction({ prefix, checks, onCheck }: { prefix: string; checks: readonly VehicleCheck[]; onCheck: () => void }) {
  const completed = checkStateOf(checks) === "completed";
  const label = completed ? "View or correct check" : "Complete check";
  return (
    <Pressable testID={`${prefix}-check-action`} onPress={onCheck} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} style={styles.checkAction}>
      <Text style={styles.openLabel}>{label}</Text>
    </Pressable>
  );
}

function VehicleUse({ use, facts, prefix, last, onOpen, onCheck }: {
  use: EndedVehicle; facts: ShiftFacts; prefix: string; last: boolean; onOpen: () => void; onCheck: () => void;
}) {
  return (
    <View style={[styles.use, last ? null : formStyles.optionDivided]}>
      <UseHeader prefix={prefix} title={`${classLabel(use.vehicleClass)} · ${use.numberPlate}`} onOpen={onOpen} />
      <Fact label="Started" value={onTheDay(facts, use.startedAt)} testID={`${prefix}-started`} />
      <Fact label="Ended" value={onTheDay(facts, use.endedAt)} testID={`${prefix}-ended`} />
      <Fact label="Start mileage" value={formatMileage(use.startMileage)} testID={`${prefix}-start-mileage`} />
      <Fact label="End mileage" value={formatMileage(use.endMileage)} testID={`${prefix}-end-mileage`} />
      <Fact label="Travelled" value={formatMileage(usageDistance(use))} testID={`${prefix}-travelled`} />
      <Entries title="Fuel" fills={fillsOfType(use.fills, FILL_TYPE.fuel)} facts={facts} prefix={`${prefix}-fuel`} />
      <Entries title="AdBlue / DEF" fills={fillsOfType(use.fills, FILL_TYPE.adblue)} facts={facts} prefix={`${prefix}-adblue`} />
      <Check checks={use.checks} prefix={prefix} />
      <CheckAction prefix={prefix} checks={use.checks} onCheck={onCheck} />
    </View>
  );
}

function TrailerUse({ use, facts, prefix, last, onOpen, onCheck }: {
  use: EndedTrailer; facts: ShiftFacts; prefix: string; last: boolean; onOpen: () => void; onCheck: () => void;
}) {
  return (
    <View style={[styles.use, last ? null : formStyles.optionDivided]}>
      <UseHeader prefix={prefix} title={`${use.trailerNumber} · ${trailerTypeLabel(use.trailerType)}`} onOpen={onOpen} />
      <Fact label="Started" value={onTheDay(facts, use.startedAt)} testID={`${prefix}-started`} />
      <Fact label="Ended" value={onTheDay(facts, use.endedAt)} testID={`${prefix}-ended`} />
      {use.trailerType === TRAILER_TYPE.refrigerated
        ? <Entries title="Fridge diesel" fills={use.reeferDiesel} facts={facts} prefix={`${prefix}-fridge-diesel`} />
        : null}
      <Check checks={use.checks} prefix={prefix} />
      <CheckAction prefix={prefix} checks={use.checks} onCheck={onCheck} />
    </View>
  );
}

/** Every entry, as recorded: when, how much — or that nobody knew — and its note. */
function Entries({ title, fills, facts, prefix }: { title: string; fills: readonly FillRecord[]; facts: ShiftFacts; prefix: string }) {
  return (
    <View style={styles.entries}>
      <Text style={styles.entriesTitle}>{title}</Text>
      {fills.length === 0 ? (
        <Text style={styles.entryNone} testID={`${prefix}-none`}>None recorded</Text>
      ) : fills.map((fill, index) => (
        <View key={fill.id} testID={`${prefix}-${String(index)}`}>
          <Text style={styles.entry} testID={`${prefix}-${String(index)}-amount`}>
            {`${onTheDay(facts, fill.recordedAt)} · ${fill.litres === null ? "Amount unknown" : formatLitres(fill.litres)}`}
          </Text>
          {fill.note === null ? null : <Text style={styles.entryNote}>{fill.note}</Text>}
        </View>
      ))}
    </View>
  );
}

/** A draft row's result, as the check screen words it. */
const DRAFT_RESULT_LABEL: Record<CheckResult, string> = {
  [CHECK_RESULT.ok]: "OK",
  [CHECK_RESULT.notApplicable]: "N/A",
  [CHECK_RESULT.defect]: "Defect",
};

/**
 * The use's check: its state; a completed certificate's defects as it says
 * them now; or, for a draft, only the rows the driver changed — uncertified.
 */
function Check({ checks, prefix }: { checks: readonly VehicleCheck[]; prefix: string }) {
  const check = latestCheck(checks);
  const completed = checkStateOf(checks) === "completed" && check !== null;
  const defects = completed ? effectiveItems(check).filter(item => item.result === CHECK_RESULT.defect) : [];
  // A draft stores the rows that differ from their defaults, and nothing else.
  const drafted = !completed && check !== null ? check.items : [];
  return (
    <View style={styles.entries}>
      <Text style={[styles.check, completed ? null : styles.notDone]} testID={`${prefix}-checks`}>{finishedCheckLabel(checks)}</Text>
      {completed ? (
        defects.length === 0
          ? <Text style={styles.entryNone} testID={`${prefix}-no-defects`}>No defects</Text>
          : defects.map((item, index) => (
            <View key={item.key} testID={`${prefix}-defect-${String(index)}`}>
              <Text style={styles.defect}>{`Defect — ${item.label}`}</Text>
              <Text style={styles.entryNote}>{item.note ?? ""}</Text>
            </View>
          ))
      ) : drafted.length === 0 ? null : (
        <View testID={`${prefix}-draft`}>
          <Text style={styles.draftHeading}>Entered, not certified</Text>
          {drafted.map((item, index) => (
            <Text
              key={item.key}
              style={item.result === CHECK_RESULT.defect ? styles.draftDefect : styles.entry}
              testID={`${prefix}-draft-${String(index)}`}
            >
              {item.result === CHECK_RESULT.defect
                ? `Draft defect: ${item.label}${item.note === null ? "" : ` — ${item.note}`}`
                : `Draft: ${item.label} — ${DRAFT_RESULT_LABEL[item.result]}`}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

function Row({ label, value, testID, last = false, stacked = false }: {
  label: string; value: string; testID: string; last?: boolean; stacked?: boolean;
}) {
  return (
    <View style={[stacked ? styles.stackedRow : styles.row, last ? null : formStyles.optionDivided]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={stacked ? styles.stackedValue : styles.rowValue} testID={testID}>{value}</Text>
    </View>
  );
}

function Fact({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue} testID={testID}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  missing: { fontSize: 16, color: colors.textMuted },
  none: { fontSize: 15, color: colors.textMuted, paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  row: { flexDirection: "row", justifyContent: "space-between", gap: spacing.lg, paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  stackedRow: { gap: spacing.xs, paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  rowLabel: { fontSize: 15, color: colors.textMuted },
  rowValue: { flexShrink: 1, fontSize: 15, fontWeight: "700", color: colors.text, textAlign: "right" },
  stackedValue: { fontSize: 15, color: colors.text },
  use: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
  useTitle: { fontSize: 17, fontWeight: "800", color: colors.text, marginBottom: spacing.xs },
  fact: { flexDirection: "row", justifyContent: "space-between", gap: spacing.lg },
  factLabel: { fontSize: 14, color: colors.textMuted },
  factValue: { flexShrink: 1, fontSize: 14, fontWeight: "600", color: colors.text, textAlign: "right" },
  entries: { marginTop: spacing.sm, gap: 2 },
  entriesTitle: { fontSize: 13, fontWeight: "700", color: colors.textMuted, letterSpacing: 0.5 },
  entry: { fontSize: 15, color: colors.text },
  entryNone: { fontSize: 14, color: colors.textMuted },
  entryNote: { fontSize: 14, color: colors.textMuted },
  check: { fontSize: 15, fontWeight: "700", color: colors.text },
  notDone: { color: colors.danger },
  defect: { fontSize: 15, fontWeight: "700", color: colors.danger },
  useHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, marginBottom: spacing.xs },
  openLabel: { fontSize: 15, fontWeight: "700", color: colors.brandLight },
  checkAction: { alignSelf: "flex-start", marginTop: spacing.sm, minHeight: 32, justifyContent: "center" },
  history: { marginTop: -spacing.md, marginBottom: spacing.xl, marginHorizontal: spacing.xs, gap: spacing.xs },
  corrected: { fontSize: 14, fontWeight: "700", color: colors.brandDark },
  historyToggle: { fontSize: 14, fontWeight: "700", color: colors.brandLight },
  historyCard: { marginTop: spacing.sm },
  historyEntry: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
  historyTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  actions: { alignItems: "center", gap: spacing.lg, marginTop: spacing.sm },
  edit: {
    alignSelf: "stretch",
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.brandLight,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  editLabel: { fontSize: 16, fontWeight: "700", color: colors.brandDark },
  delete: { minHeight: 44, justifyContent: "center" },
  deleteLabel: { fontSize: 15, fontWeight: "700", color: colors.danger },
  draftHeading: { fontSize: 13, fontWeight: "700", color: colors.textMuted, letterSpacing: 0.5, marginTop: spacing.xs },
  draftDefect: { fontSize: 15, color: colors.danger },
  unconfirmed: { gap: spacing.md, backgroundColor: colors.dangerBg, borderRadius: 12, padding: spacing.md, marginBottom: spacing.xl },
  unconfirmedText: { fontSize: 15, fontWeight: "600", color: colors.danger },
});
