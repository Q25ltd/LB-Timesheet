/**
 * Trailer Use — one ENDED trailer use from the open day, to read and correct.
 * The trailer's counterpart of Vehicle Use, in the same visual language.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IT SHOWS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A USED THIS SHIFT → TRAILERS row opens THAT use — never another use of the
 * same trailer number — with its number, type, hours and duration, its
 * Trailer Check (state, and a completed certificate's defects), and on a
 * refrigerated trailer its fridge diesel.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT MAY STILL BE DONE TO IT (D34, D35)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A FORGOTTEN TRAILER CHECK. If the use has no completed check, Trailer Checks
 * opens its draft, or a fresh one, for this exact ended use; completing it
 * records when it was actually completed — never the trailer's hours. A
 * completed check opens read-only, as every certificate does.
 *
 * FRIDGE DIESEL, on a refrigerated trailer only: Edit adds, corrects or
 * removes its entries on the Fridge Diesel form opened for this use.
 *
 * Never editable here: the trailer number, its type, when the use started and
 * ended, and a completed certificate. A standard trailer has nothing to Edit,
 * so it offers no Edit at all.
 */
import { useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import { TRAILER_TYPE, trailerTypeLabel, type EndedTrailer, type LocalTrailer } from "../shift/trailer";
import { USE_ENDED_BY } from "../shift/useEnd";
import { UseTimesEditor, type UseTimes } from "./UseTimesEditor";
import { CHECK_RESULT, checkStateOf, effectiveItems, latestCheck } from "../shift/vehicleCheck";
import { summariseRecords } from "../shift/vehicleFill";
import { BackButton, FormSection, formStyles } from "./vehicleForm";
import { checkDetailLabel, fillSummaryText, formatClockTime, formatDuration, formatLitres } from "./format";
import { colors, radius, sizing, spacing } from "../theme/index";

interface TrailerUsageScreenProps {
  /** An ended use — or, from the Finish Review, the trailer still in use (D41). */
  use: LocalTrailer | EndedTrailer;
  onLeave: () => void;
  /** Open this use's Trailer Check — its draft, a fresh one, or its certificate. */
  onTrailerChecks: () => void;
  /** Open the Fridge Diesel form for THIS use, to add to, correct or remove its entries. */
  onFridgeDiesel: () => void;
  /** Correct THIS use's trailer number, typed wrong (D40). */
  onCorrectNumber: () => void;
  /** Store corrected start / end times on this use (D42). Rejects if they could not be stored. */
  onSaveTimes: (times: UseTimes) => Promise<void>;
}

export function TrailerUsageScreen({ use, onLeave, onTrailerChecks, onFridgeDiesel, onCorrectNumber, onSaveTimes }: TrailerUsageScreenProps) {
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState(false);
  const refrigerated = use.trailerType === TRAILER_TYPE.refrigerated;
  const hours = `${formatClockTime(use.startedAt)}–${"endedAt" in use ? formatClockTime(use.endedAt) : "in use"}`;

  return (
    <View style={formStyles.screen}>
      <ScrollView
        testID="trailer-usage-scroll"
        style={formStyles.screen}
        contentContainerStyle={[
          formStyles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
      >
        <BackButton testID="trailer-usage-back" onPress={editing ? () => { setEditing(false); } : onLeave} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">
          {editing ? "Edit Trailer Use" : "Trailer Use"}
        </Text>

        {/* Who and when — stated, never an input, in either mode. */}
        <View style={styles.identity}>
          <Text style={styles.number} testID="trailer-usage-number" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {use.trailerNumber}
          </Text>
          <Text style={styles.meta} testID="trailer-usage-type-hours">{`${trailerTypeLabel(use.trailerType)} · ${hours}`}</Text>
          {editing ? null : (
            <Pressable testID="trailer-usage-correct-number" onPress={onCorrectNumber} accessibilityRole="button" accessibilityLabel="Correct trailer number" hitSlop={8} style={styles.correctName}>
              <Text style={styles.correctNameLabel}>Correct trailer number</Text>
            </Pressable>
          )}
        </View>

        {editing
          ? <EditTrailerUse use={use} refrigerated={refrigerated} onFridgeDiesel={onFridgeDiesel} onSaveTimes={onSaveTimes} onDone={() => { setEditing(false); }} />
          : (
            <>
              <TrailerUseDetail use={use} onTrailerChecks={onTrailerChecks} />
              {/* Its times are editable on every trailer; fridge diesel only on a refrigerated one (D42). */}
              <OutlinedAction label="Edit" onPress={() => { setEditing(true); }} testID="trailer-usage-edit" />
            </>
          )}
      </ScrollView>
    </View>
  );
}

function TrailerUseDetail({ use, onTrailerChecks }: { use: LocalTrailer | EndedTrailer; onTrailerChecks: () => void }) {
  const ended = "endedAt" in use ? use : null;
  const state = checkStateOf(use.checks);
  const check = latestCheck(use.checks);
  const completed = state === "completed" && check !== null;
  // What the certificate says NOW — its latest correction, or the original.
  const defects = completed ? effectiveItems(check).filter(item => item.result === CHECK_RESULT.defect) : [];

  return (
    <>
      <View style={[formStyles.card, styles.facts]}>
        <Row label="Started" value={formatClockTime(use.startedAt)} testID="trailer-usage-started" />
        {ended === null ? (
          <Row label="Ended" value="At the finish" testID="trailer-usage-ended" />
        ) : (
          <>
            <Row label="Ended" value={formatClockTime(ended.endedAt)} testID="trailer-usage-ended" />
            <Row label="Duration" value={formatDuration(ended.startedAt, ended.endedAt)} testID="trailer-usage-duration" />
          </>
        )}
        <Row label="Trailer checks" value={checkDetailLabel(use.checks)} testID="trailer-usage-checks" last />
      </View>

      <FormSection label="TRAILER CHECK">
        {completed ? (
          <View testID="trailer-usage-certificate">
            <Text style={styles.certified} testID="trailer-usage-completed-at">
              {`Completed at ${formatClockTime(check.completedAt ?? check.startedAt)}`}
            </Text>
            {defects.length === 0
              ? <Text style={styles.none} testID="trailer-usage-no-defects">No defects</Text>
              : defects.map((item, index) => (
                <View key={item.key} style={[styles.entry, index === defects.length - 1 ? null : formStyles.optionDivided]} testID={`trailer-usage-defect-${item.key}`}>
                  <Text style={styles.entryTitle}>{item.label}</Text>
                  <Text style={styles.entryNote}>{item.note}</Text>
                </View>
              ))}
          </View>
        ) : (
          // A check forgotten before the trailer went back: say so plainly.
          <Text style={styles.none} testID="trailer-usage-check-missing">
            {state === "in-progress" ? "Started, not completed" : "Not completed"}
          </Text>
        )}
      </FormSection>

      <View style={styles.checkAction}>
        {completed
          ? <OutlinedAction label="View Trailer Check" onPress={onTrailerChecks} testID="trailer-usage-checks-open" />
          : <PrimaryButton label="Trailer Checks" onPress={onTrailerChecks} testID="trailer-usage-checks-open" />}
      </View>

      {use.trailerType === TRAILER_TYPE.refrigerated ? (
        <FormSection label="FRIDGE DIESEL">
          {use.reeferDiesel.length === 0
            ? <Text style={styles.none} testID="trailer-usage-diesel-none">No entries</Text>
            : (
              <View testID="trailer-usage-diesel">
                {use.reeferDiesel.map((fill, index) => (
                  <View key={fill.id} testID={`trailer-usage-fill-${fill.id}`} style={[styles.entry, index === use.reeferDiesel.length - 1 ? null : formStyles.optionDivided]}>
                    <View style={styles.entryHead}>
                      <Text style={styles.entryTitle}>{fill.litres === null ? "Amount unknown" : formatLitres(fill.litres)}</Text>
                      <Text style={styles.meta}>{formatClockTime(fill.recordedAt)}</Text>
                    </View>
                    {fill.note === null ? null : <Text style={styles.entryNote}>{fill.note}</Text>}
                  </View>
                ))}
              </View>
            )}
        </FormSection>
      ) : null}
    </>
  );
}

/** A refrigerated use's one editable thing: its fridge diesel, on its own form. */
function EditTrailerUse({ use, refrigerated, onFridgeDiesel, onSaveTimes, onDone }: {
  use: LocalTrailer | EndedTrailer; refrigerated: boolean; onFridgeDiesel: () => void; onSaveTimes: (times: UseTimes) => Promise<void>; onDone: () => void;
}) {
  const total = fillSummaryText(summariseRecords(use.reeferDiesel));
  const said = total === null ? "No entries" : `${total.amount} · ${total.detail}`;
  const ended = "endedAt" in use ? use : null;
  return (
    <>
      <UseTimesEditor
        prefix="trailer-usage"
        startedAt={use.startedAt}
        endedAt={ended?.endedAt ?? null}
        endsWithFinish={ended?.endedBy === USE_ENDED_BY.finish}
        onSave={onSaveTimes}
      />
      {refrigerated ? <FormSection label="FRIDGE DIESEL">
        <Pressable
          testID="trailer-usage-edit-diesel"
          onPress={onFridgeDiesel}
          accessibilityRole="button"
          accessibilityLabel={`Fridge Diesel. ${said}. Add or edit`}
          style={({ pressed }) => [formStyles.option, pressed ? formStyles.optionPressed : null]}
        >
          <View style={styles.editText}>
            <Text style={styles.editTitle}>Add or edit Fridge Diesel</Text>
            <Text style={styles.meta} testID="trailer-usage-edit-diesel-total">{said}</Text>
          </View>
          <View style={styles.chevron} />
        </Pressable>
      </FormSection> : null}
      <OutlinedAction label="Done" onPress={onDone} testID="trailer-usage-done" />
    </>
  );
}

function OutlinedAction({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.outlined, pressed ? formStyles.optionPressed : null]}
    >
      <Text style={styles.outlinedLabel}>{label}</Text>
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
  number: { fontSize: 28, fontWeight: "800", color: colors.text, letterSpacing: 1 },
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
  certified: { fontSize: 15, fontWeight: "700", color: colors.success, paddingTop: spacing.md, paddingHorizontal: spacing.lg },
  entry: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
  entryHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.md },
  entryTitle: { fontSize: 17, fontWeight: "700", color: colors.text },
  entryNote: { fontSize: 14, color: colors.textMuted, fontStyle: "italic" },

  checkAction: { marginTop: -spacing.sm, marginBottom: spacing.xl },

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

  outlined: {
    minHeight: sizing.control,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  outlinedLabel: { fontSize: 16, fontWeight: "700", color: colors.brandDark },
});
