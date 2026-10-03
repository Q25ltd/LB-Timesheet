/**
 * Vehicle Use — one ENDED use of a vehicle from the open day, and the one place
 * it is corrected.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IT IS FOR
 * ════════════════════════════════════════════════════════════════════════════
 *
 * USED THIS SHIFT on Active Shift is a compact list: plate, class, mileage.
 * Pressing a row opens THAT use here — never another use of the same plate —
 * with everything it holds: its hours, its mileages, its check status and the
 * fuel and AdBlue recorded on it.
 *
 * It is also where a mistake is put right while the day is open (D31). A
 * driver who typed 18 for 180 when they handed the truck back, or who forgot
 * the 300 litres they put in before the change, fixes it on this use rather
 * than against whatever they are driving now.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT EDIT MAY CHANGE, AND WHAT IT MAY NOT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Editable: the END MILEAGE (never below the start), and the use's FUEL and
 * ADBLUE entries — added, corrected or removed on the same fill screen the
 * vehicle in use has, opened for this use.
 *
 * Not editable here, and not shown as inputs: the plate, the class, when the
 * use started and ended, the start mileage, and its checks. A completed check
 * is a certificate and stays exactly as it was signed; this screen reports its
 * status and nothing more.
 *
 * Available whether or not a vehicle is in use now: a driver between vehicles
 * must not have to take one to correct the morning's.
 */
import { useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import type { EndedVehicle, LocalVehicle } from "../shift/localShift";
import { USE_ENDED_BY } from "../shift/useEnd";
import { UseTimesEditor, type UseTimes } from "./UseTimesEditor";
import { checkStateOf } from "../shift/vehicleCheck";
import { FILL_TYPES, fillsOfType, summariseFills, type FillType } from "../shift/vehicleFill";
import { usageDistance } from "../shift/usedVehicles";
import { BackButton, FormSection, formStyles, keyboardSafeScrollProps, parseMileage } from "./vehicleForm";
import { checkDetailLabel, classLabel, fillSummaryText, formatClockTime, formatLitres, formatMileage } from "./format";
import { colors, radius, sizing, spacing, typography } from "../theme/index";

/** A use still in progress has no end yet; one that has ended has both. */
function endOf(use: LocalVehicle | EndedVehicle): EndedVehicle | null {
  return "endedAt" in use ? use : null;
}

interface VehicleUsageScreenProps {
  /** An ended use — or, from the Finish Review, the use still in progress (D41). */
  use: LocalVehicle | EndedVehicle;
  onLeave: () => void;
  /** Open THIS use's Vehicle / Unit Check — a forgotten one to complete, or its certificate (D36). */
  onVehicleChecks: () => void;
  /** Open the fill screen for THIS use, to add to, correct or remove its entries. */
  onFills: (type: FillType) => void;
  /** Store a corrected end mileage on this use. Rejects if it could not be stored. */
  onSaveEndMileage: (endMileage: number) => Promise<void>;
  /** Store a corrected start mileage on this use (D41). Rejects if it could not be stored. */
  onSaveStartMileage: (startMileage: number) => Promise<void>;
  /** Correct THIS use's plate, typed wrong (D40). */
  onCorrectPlate: () => void;
  /** Store corrected start / end times on this use (D42). Rejects if they could not be stored. */
  onSaveTimes: (times: UseTimes) => Promise<void>;
}

export function VehicleUsageScreen({ use, onLeave, onVehicleChecks, onFills, onSaveEndMileage, onSaveStartMileage, onCorrectPlate, onSaveTimes }: VehicleUsageScreenProps) {
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState(false);
  const ended = endOf(use);
  const hours = `${formatClockTime(use.startedAt)}–${ended === null ? "in use" : formatClockTime(ended.endedAt)}`;

  return (
    <View style={formStyles.screen}>
      <ScrollView
        testID="vehicle-usage-scroll"
        style={formStyles.screen}
        contentContainerStyle={[
          formStyles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        // The end mileage field sits low on a phone; the keyboard must not cover it.
        {...keyboardSafeScrollProps}
      >
        {/* Back out of Edit returns to the use, not off the screen. */}
        <BackButton testID="usage-back" onPress={editing ? () => { setEditing(false); } : onLeave} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">
          {editing ? "Edit Vehicle Use" : "Vehicle Use"}
        </Text>

        {/* Who and when — stated, never an input, in either mode. */}
        <View style={styles.identity}>
          <Text style={styles.plate} testID="usage-plate" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {use.numberPlate}
          </Text>
          <Text style={styles.meta} testID="usage-class-hours">{`${classLabel(use.vehicleClass)} · ${hours}`}</Text>
          {editing ? null : (
            <Pressable testID="usage-correct-plate" onPress={onCorrectPlate} accessibilityRole="button" accessibilityLabel="Correct registration number" hitSlop={8} style={styles.correctName}>
              <Text style={styles.correctNameLabel}>Correct registration number</Text>
            </Pressable>
          )}
        </View>

        {editing
          ? <EditUsage use={use} onFills={onFills} onSaveEndMileage={onSaveEndMileage} onSaveStartMileage={onSaveStartMileage} onSaveTimes={onSaveTimes} onDone={() => { setEditing(false); }} />
          : <UsageDetail use={use} onVehicleChecks={onVehicleChecks} onEdit={() => { setEditing(true); }} />}
      </ScrollView>
    </View>
  );
}

function UsageDetail({ use, onVehicleChecks, onEdit }: { use: LocalVehicle | EndedVehicle; onVehicleChecks: () => void; onEdit: () => void }) {
  const completed = checkStateOf(use.checks) === "completed";
  const ended = endOf(use);
  const noun = use.vehicleClass === "class1" ? "Unit Check" : "Vehicle Check";
  return (
    <>
      <View style={[formStyles.card, styles.facts]}>
        <Row label="Start mileage" value={formatMileage(use.startMileage)} testID="usage-start-mileage" />
        {ended === null ? (
          // Still in use: its end mileage is the final mileage given at the finish.
          <Row label="End mileage" value="At the finish" testID="usage-end-mileage" />
        ) : (
          <>
            <Row label="End mileage" value={formatMileage(ended.endMileage)} testID="usage-end-mileage" />
            <Row label="Travelled" value={formatMileage(usageDistance(ended))} testID="usage-travelled" />
          </>
        )}
        <Row label="Vehicle checks" value={checkDetailLabel(use.checks)} testID="usage-checks" last />
      </View>

      {/* A check forgotten before the vehicle went back can still be completed
          for THIS use; a completed one opens as its certificate (D36). */}
      <Pressable
        testID="usage-vehicle-checks"
        onPress={onVehicleChecks}
        accessibilityRole="button"
        accessibilityLabel={completed ? `View ${noun}` : `Complete ${noun}`}
        style={({ pressed }) => [styles.done, styles.checkAction, pressed ? formStyles.optionPressed : null]}
      >
        <Text style={styles.doneLabel}>{completed ? `View ${noun}` : `Complete ${noun}`}</Text>
      </Pressable>

      {FILL_TYPES.map(entry => (
        <FormSection key={entry.id} label={entry.label.toUpperCase()}>
          <FillList use={use} type={entry.id} />
        </FormSection>
      ))}

      <PrimaryButton label="Edit" onPress={onEdit} testID="usage-edit" />
    </>
  );
}

/**
 * Every entry of one type on this use, oldest first, as recorded — an unknown
 * amount says so and is never shown as 0 L.
 */
function FillList({ use, type }: { use: LocalVehicle | EndedVehicle; type: FillType }) {
  const fills = fillsOfType(use.fills, type);
  if (fills.length === 0) {
    return <Text style={styles.none} testID={`usage-${type}-none`}>No entries</Text>;
  }
  return (
    <View testID={`usage-${type}-entries`}>
      {fills.map((fill, index) => (
        <View
          key={fill.id}
          testID={`usage-fill-${fill.id}`}
          style={[styles.fill, index === fills.length - 1 ? null : formStyles.optionDivided]}
        >
          <View style={styles.fillHead}>
            <Text style={styles.fillAmount}>{fill.litres === null ? "Amount unknown" : formatLitres(fill.litres)}</Text>
            <Text style={styles.meta}>{formatClockTime(fill.recordedAt)}</Text>
          </View>
          {fill.note === null ? null : <Text style={styles.fillNote}>{fill.note}</Text>}
        </View>
      ))}
    </View>
  );
}

/**
 * What this use may still have corrected, each committed on its own: its
 * start mileage (D41) and — once it has ended — its end mileage, by their own
 * buttons here, and each fill on the fill screen, exactly as it is for the
 * vehicle in use.
 */
function EditUsage({ use, onFills, onSaveEndMileage, onSaveStartMileage, onSaveTimes, onDone }: {
  use: LocalVehicle | EndedVehicle;
  onFills: (type: FillType) => void;
  onSaveEndMileage: (endMileage: number) => Promise<void>;
  onSaveStartMileage: (startMileage: number) => Promise<void>;
  onSaveTimes: (times: UseTimes) => Promise<void>;
  onDone: () => void;
}) {
  const ended = endOf(use);
  return (
    <>
      <UseTimesEditor
        prefix="usage"
        startedAt={use.startedAt}
        endedAt={ended?.endedAt ?? null}
        endsWithFinish={ended?.endedBy === USE_ENDED_BY.finish}
        onSave={onSaveTimes}
      />
      <StartMileageField use={use} onSave={onSaveStartMileage} />
      {ended === null ? null : <EndMileageField use={ended} onSave={onSaveEndMileage} />}

      <View style={styles.fillsEdit}>
        {FILL_TYPES.map(entry => (
          <FormSection key={entry.id} label={entry.label.toUpperCase()}>
            <FillEditRow use={use} type={entry.id} label={entry.label} onPress={() => { onFills(entry.id); }} />
          </FormSection>
        ))}
      </View>

      <Pressable
        testID="usage-done"
        onPress={onDone}
        accessibilityRole="button"
        accessibilityLabel="Done"
        style={({ pressed }) => [styles.done, pressed ? formStyles.optionPressed : null]}
      >
        <Text style={styles.doneLabel}>Done</Text>
      </Pressable>
    </>
  );
}

/**
 * The start mileage, typed wrong: never above an ended use's end mileage.
 * Changes nothing else about the use.
 */
function StartMileageField({ use, onSave }: { use: LocalVehicle | EndedVehicle; onSave: (startMileage: number) => Promise<void> }) {
  const ended = endOf(use);
  const [startText, setStartText] = useState(String(use.startMileage));
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);

  const startMileage = parseMileage(startText);
  const aboveEnd = ended !== null && startMileage !== null && startMileage > ended.endMileage;
  const valid = startMileage !== null && !aboveEnd;
  const changed = valid && startMileage !== use.startMileage;

  function save() {
    if (!changed || startMileage === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    onSave(startMileage).then(
      () => { inFlight.current = false; setSubmitting(false); setSaved(true); },
      () => { inFlight.current = false; setSubmitting(false); },
    );
  }

  return (
    <>
      <FormSection label="START MILEAGE">
        <TextInput
          testID="usage-start-mileage-input"
          value={startText}
          onChangeText={next => { setStartText(next); setSaved(false); }}
          keyboardType="number-pad"
          selectTextOnFocus
          style={formStyles.input}
          accessibilityLabel="Start mileage"
        />
      </FormSection>
      {aboveEnd ? (
        <Text style={styles.error} testID="usage-start-mileage-hint">
          {`Start mileage cannot be above the end mileage (${formatMileage(ended.endMileage)}).`}
        </Text>
      ) : null}
      <PrimaryButton label="Save Start Mileage" onPress={save} disabled={!changed} submitting={submitting} testID="usage-start-mileage-save" />
      {saved ? <Text style={styles.saved} testID="usage-start-mileage-saved">Start mileage saved.</Text> : null}
      <View style={styles.between} />
    </>
  );
}

function EndMileageField({ use, onSave }: { use: EndedVehicle; onSave: (endMileage: number) => Promise<void> }) {
  const [endText, setEndText] = useState(String(use.endMileage));
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  /** ONE write, however many taps — set synchronously, before any re-render. */
  const inFlight = useRef(false);

  const endMileage = parseMileage(endText);
  const belowStart = endMileage !== null && endMileage < use.startMileage;
  const valid = endMileage !== null && !belowStart;
  const changed = valid && endMileage !== use.endMileage;

  function save() {
    if (!changed || endMileage === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    onSave(endMileage).then(
      () => { inFlight.current = false; setSubmitting(false); setSaved(true); },
      () => { inFlight.current = false; setSubmitting(false); },
    );
  }

  return (
    <>
      <FormSection label="END MILEAGE">
        <TextInput
          testID="usage-end-mileage-input"
          value={endText}
          onChangeText={next => { setEndText(next); setSaved(false); }}
          keyboardType="number-pad"
          selectTextOnFocus
          style={formStyles.input}
          accessibilityLabel="End mileage"
        />
      </FormSection>
      {/* The start is the floor, so it is stated next to the field; the
          distance follows what is typed, never what is stored. */}
      <Text style={belowStart ? styles.error : styles.hint} testID="usage-end-mileage-hint">
        {belowStart
          ? `End mileage cannot be below the start mileage (${formatMileage(use.startMileage)}).`
          : `Start mileage ${formatMileage(use.startMileage)}${valid ? ` · Travelled ${formatMileage(endMileage - use.startMileage)}` : ""}`}
      </Text>
      <PrimaryButton
        label="Save End Mileage"
        onPress={save}
        disabled={!changed}
        submitting={submitting}
        testID="usage-end-mileage-save"
      />
      {saved ? <Text style={styles.saved} testID="usage-end-mileage-saved">End mileage saved.</Text> : null}
    </>
  );
}

/** One type's total on this use, and the way into its entries. */
function FillEditRow({ use, type, label, onPress }: {
  use: LocalVehicle | EndedVehicle; type: FillType; label: string; onPress: () => void;
}) {
  const total = fillSummaryText(summariseFills(use.fills, type));
  const said = total === null ? "No entries" : `${total.amount} · ${total.detail}`;
  return (
    <Pressable
      testID={`usage-edit-${type}`}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${said}. Add or edit`}
      style={({ pressed }) => [formStyles.option, pressed ? formStyles.optionPressed : null]}
    >
      <View style={styles.editText}>
        <Text style={styles.editTitle}>{`Add or edit ${label}`}</Text>
        <Text style={styles.meta} testID={`usage-edit-${type}-total`}>{said}</Text>
      </View>
      <View style={styles.chevron} />
    </Pressable>
  );
}

function Row({ label, value, testID, last = false }: { label: string; value: string; testID: string; last?: boolean }) {
  return (
    <View style={[styles.row, last ? null : formStyles.optionDivided]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} testID={testID}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  correctName: { alignSelf: "flex-start", minHeight: 36, justifyContent: "center", marginTop: spacing.xs },
  correctNameLabel: { fontSize: 14, fontWeight: "600", color: colors.brandLight },
  identity: { marginTop: -spacing.md, marginBottom: spacing.xl, gap: 2 },
  plate: { fontSize: 28, fontWeight: "800", color: colors.text, letterSpacing: 1 },
  meta: { fontSize: 15, color: colors.textMuted },

  facts: { marginBottom: spacing.xl },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  rowLabel: { fontSize: 15, color: colors.textMuted },
  rowValue: { flexShrink: 1, fontSize: 16, fontWeight: "700", color: colors.text, textAlign: "right" },

  none: { fontSize: 15, color: colors.textMuted, paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  fill: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
  fillHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.md },
  fillAmount: { fontSize: 17, fontWeight: "700", color: colors.text },
  fillNote: { fontSize: 14, color: colors.textMuted, fontStyle: "italic" },

  hint: { ...typography.helper, marginTop: -spacing.md, marginBottom: spacing.lg, marginHorizontal: spacing.xs },
  error: { ...typography.error, marginTop: -spacing.md, marginBottom: spacing.lg, marginHorizontal: spacing.xs },
  saved: { ...typography.helper, color: colors.success, textAlign: "center", marginTop: spacing.sm },

  fillsEdit: { marginTop: spacing.xl },
  between: { height: spacing.xl },
  editText: { flex: 1, gap: 2 },
  editTitle: { fontSize: 17, fontWeight: "700", color: colors.brandDark },
  chevron: {
    width: 10,
    height: 10,
    borderRightWidth: 2.5,
    borderTopWidth: 2.5,
    borderColor: colors.textMuted,
    transform: [{ rotate: "45deg" }],
  },

  checkAction: { marginTop: -spacing.sm, marginBottom: spacing.xl },
  done: {
    minHeight: sizing.control,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  doneLabel: { fontSize: 16, fontWeight: "700", color: colors.brandDark },
});
