/**
 * Add Fuel / Add AdBlue — what went into one vehicle use, and when.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FAST FOR A DRIVER STANDING AT A PUMP
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The time is already filled in, the amount is two big choices, and the
 * quantity field only exists once the driver says they know it. A yard fill
 * with a broken meter is three presses — Amount unknown, Add — and the
 * keyboard never has to open.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNKNOWN IS AN ANSWER, NOT AN EMPTY FIELD
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The driver SAYS which it is. There is no way to submit a blank quantity by
 * accident and no way to submit 0 as a stand-in: "Amount known" requires a
 * real reading, and "Amount unknown" stores no quantity at all
 * (`vehicleFill.ts`). No reason is asked for, because not knowing is normal
 * and explaining it is not the driver's job.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ONE USE, NAMED BY WHOEVER OPENED IT — NEVER CHOSEN HERE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A fill belongs to one exact vehicle USE, and this screen is always opened
 * FOR one (D31). Fuel and AdBlue under the vehicle in use open it for that
 * use; a used vehicle's Edit opens it for that ended use, which is how a fill
 * forgotten before a change is put right. There is no chooser: the ordinary
 * fill of the truck being driven costs no extra tap, and a retrospective one
 * starts from the use it belongs to rather than from a list of the day.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE LIST BELOW IS THIS USE'S, AND IT IS CORRECTABLE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Everything recorded on this use is listed under the form, so the driver can
 * see what they entered and fix a mistake: pressing one loads it back, where
 * it can be corrected or removed. Editing changes the quantity, the time and
 * the note — never the use it belongs to.
 */
import { useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import {
  FILL_NOTE_MAX_LENGTH,
  fillTypeLabel,
  fillsOfType,
  parseLitres,
  type FillType,
  type VehicleFill,
} from "../shift/vehicleFill";
import {
  BackButton,
  Choice,
  FormSection,
  formStyles,
  keyboardSafeScrollProps,
} from "./vehicleForm";
import { TimeOfDayFields, timeStyles, useTimeOfDay } from "./timeOfDay";
import { formatClockTime, formatLitres } from "./format";
import { colors, spacing, typography } from "../theme/index";

/** What the driver confirms: one fill, as entered, on the use this screen is for. */
export interface FillEntry {
  /** The fill being corrected, or `null` for a new one. */
  fillId: string | null;
  recordedAt: Date;
  /** Litres, or `null` when the driver says the amount is unknown. */
  litres: number | null;
  note: string;
}

/** The one vehicle use this screen records against. */
export interface FillUsage {
  numberPlate: string;
  /**
   * When an ENDED use ran — "05:30–10:00" — so a driver correcting one of two
   * uses of the same registration can see which. `null` for the vehicle in
   * use, which the plate alone names.
   */
  hours: string | null;
  fills: readonly VehicleFill[];
}

interface VehicleFillScreenProps {
  type: FillType;
  usage: FillUsage;
  onLeave: () => void;
  /** Store the fill on this screen's use. Rejects if it could not be stored. */
  onSave: (entry: FillEntry) => Promise<void>;
  /** Remove one already recorded on this screen's use. */
  onRemove: (fillId: string) => Promise<void>;
}

type Amount = "known" | "unknown" | null;

export function VehicleFillScreen({ type, usage, onLeave, onSave, onRemove }: VehicleFillScreenProps) {
  const insets = useSafeAreaInsets();
  const label = fillTypeLabel(type);
  const recorded = fillsOfType(usage.fills, type);

  const time = useTimeOfDay(() => new Date());
  const [amount, setAmount] = useState<Amount>(null);
  const [litresText, setLitresText] = useState("");
  const [note, setNote] = useState("");
  /** The fill being corrected. `null` while adding a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The instant that fill already carries — corrections keep its DAY. */
  const [editingAt, setEditingAt] = useState<Date | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** ONE write, however many taps — set synchronously, before any re-render. */
  const inFlight = useRef(false);

  const litres = parseLitres(litresText);
  const litresInvalid = amount === "known" && litresText.trim() !== "" && litres === null;
  const complete = time.valid && (amount === "unknown" || (amount === "known" && litres !== null));

  function edit(fill: VehicleFill) {
    setEditing(fill.id);
    setEditingAt(new Date(fill.recordedAt));
    setAmount(fill.litres === null ? "unknown" : "known");
    setLitresText(fill.litres === null ? "" : String(fill.litres));
    setNote(fill.note ?? "");
    const at = new Date(fill.recordedAt);
    time.setHours(String(at.getHours()).padStart(2, "0"));
    time.setMinutes(String(at.getMinutes()).padStart(2, "0"));
  }

  function clear() {
    setEditing(null);
    setEditingAt(null);
    setAmount(null);
    setLitresText("");
    setNote("");
  }

  function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    action().then(
      () => { clear(); inFlight.current = false; setSubmitting(false); },
      () => { inFlight.current = false; setSubmitting(false); },
    );
  }

  function save() {
    // A correction stays on its own day; a new fill lands on this one.
    const recordedAt = time.at(editingAt ?? undefined);
    if (!complete || recordedAt === null) return;
    run(() => onSave({
      fillId: editing,
      recordedAt,
      litres: amount === "known" ? litres : null,
      note,
    }));
  }

  return (
    <View style={formStyles.screen}>
      <ScrollView
        testID="vehicle-fill-scroll"
        style={formStyles.screen}
        contentContainerStyle={[
          formStyles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        // The litres field sits low on a phone; the keyboard must not cover it.
        {...keyboardSafeScrollProps}
      >
        <BackButton testID="fill-back" onPress={onLeave} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">
          {editing === null ? `Add ${label}` : `Edit ${label}`}
        </Text>
        <Text style={styles.subtitle} testID="fill-vehicle">
          {usage.hours === null ? usage.numberPlate : `${usage.numberPlate} · ${usage.hours}`}
        </Text>

        <FormSection label="TIME">
          <TimeOfDayFields testID="fill-time" time={time} />
          <Text style={timeStyles.hint}>
            Set to now. Change it if you filled up earlier.
          </Text>
        </FormSection>

        <FormSection label="AMOUNT">
          <View accessibilityRole="radiogroup">
            <Choice
              testID="amount-known"
              label="Amount known"
              selected={amount === "known"}
              onSelect={() => { setAmount("known"); }}
              last={false}
            />
            <Choice
              testID="amount-unknown"
              label="Amount unknown"
              selected={amount === "unknown"}
              onSelect={() => { setAmount("unknown"); setLitresText(""); }}
              last
            />
          </View>
        </FormSection>

        {amount === "known" ? (
          <FormSection label="LITRES">
            <TextInput
              testID="litres"
              value={litresText}
              onChangeText={setLitresText}
              placeholder="0"
              placeholderTextColor={colors.placeholder}
              keyboardType="decimal-pad"
              style={formStyles.input}
              accessibilityLabel="Litres"
            />
          </FormSection>
        ) : null}
        {litresInvalid ? (
          <Text style={styles.error} testID="litres-error">Enter the litres the pump showed.</Text>
        ) : null}

        <FormSection label="NOTE (OPTIONAL)">
          <TextInput
            testID="fill-note"
            value={note}
            onChangeText={setNote}
            placeholder="Yard pump — meter broken"
            placeholderTextColor={colors.placeholder}
            maxLength={FILL_NOTE_MAX_LENGTH}
            multiline
            style={[formStyles.input, styles.note]}
            accessibilityLabel="Note"
          />
        </FormSection>

        <View style={formStyles.action}>
          <PrimaryButton
            label={editing === null ? `Add ${label}` : "Save"}
            onPress={save}
            disabled={!complete}
            submitting={submitting}
            testID="fill-save"
          />
        </View>

        {editing === null ? null : (
          <View style={styles.editActions}>
            <TextAction testID="fill-remove" label={`Remove this ${label.toLowerCase()} entry`} danger onPress={() => { run(() => onRemove(editing)); }} />
            <TextAction testID="fill-cancel-edit" label="Cancel" danger={false} onPress={clear} />
          </View>
        )}

        {recorded.length === 0 ? null : (
          <>
            <Text style={styles.sectionLabel} testID="recorded-label">{`${label.toUpperCase()} ON THIS VEHICLE`}</Text>
            <View style={formStyles.card} testID="recorded-fills">
              {recorded.map((fill, index) => (
                <Pressable
                  key={fill.id}
                  testID={`fill-${fill.id}`}
                  onPress={() => { edit(fill); }}
                  accessibilityRole="button"
                  accessibilityLabel={`${formatClockTime(fill.recordedAt)}, ${fill.litres === null ? "amount unknown" : formatLitres(fill.litres)}. Edit`}
                  accessibilityState={{ selected: fill.id === editing }}
                  style={({ pressed }) => [
                    styles.row,
                    index === recorded.length - 1 ? null : formStyles.optionDivided,
                    pressed ? formStyles.optionPressed : null,
                  ]}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.rowAmount}>
                      {fill.litres === null ? "Amount unknown" : formatLitres(fill.litres)}
                    </Text>
                    <Text style={styles.rowMeta}>{formatClockTime(fill.recordedAt)}</Text>
                    {fill.note === null ? null : <Text style={styles.rowNote}>{fill.note}</Text>}
                  </View>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

/** A plain text action — secondary to the button above it, and never louder. */
function TextAction({ testID, label, danger, onPress }: {
  testID: string; label: string; danger: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [styles.textAction, pressed ? formStyles.optionPressed : null]}
    >
      <Text style={[styles.textActionLabel, danger ? styles.dangerLabel : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  subtitle: { ...typography.subtitle, marginTop: -spacing.md, marginBottom: spacing.xl },
  note: { minHeight: 88, paddingTop: spacing.md, textAlignVertical: "top" },
  error: { ...typography.error, marginTop: -spacing.md, marginBottom: spacing.lg, marginLeft: spacing.xs },
  editActions: { alignItems: "center", gap: spacing.xs, marginTop: spacing.md },
  textAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg },
  textActionLabel: { fontSize: 16, fontWeight: "600", color: colors.textMuted },
  dangerLabel: { color: colors.danger },
  sectionLabel: { ...typography.label, letterSpacing: 1, marginTop: spacing.xxl, marginBottom: spacing.sm, marginLeft: spacing.xs },
  row: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
  rowText: { gap: 2 },
  rowAmount: { fontSize: 18, fontWeight: "700", color: colors.text },
  rowMeta: { fontSize: 14, color: colors.textMuted },
  rowNote: { fontSize: 14, color: colors.textMuted, fontStyle: "italic" },
});
