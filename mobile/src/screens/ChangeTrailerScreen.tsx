/**
 * Change Trailer — hand the trailer in use back, and take another or none (D34).
 *
 * Two answers: a different trailer, or NO TRAILER (owner correction,
 * 2026-09-27 — trailers used earlier are listed on Active Shift, not offered
 * back here). There is no mileage to ask — a trailer has no odometer the
 * driver reads — so each answer is one step and one button.
 *
 * EVERY ANSWER IS A NEW USE. Typing TR1234 again after lunch starts it afresh:
 * this morning's fridge diesel and Trailer Check stay on this morning's use.
 *
 * NO TRAILER IS NOT A PROBLEM. The shift and the vehicle carry on untouched;
 * a trailer taken later begins at its own time.
 *
 * Nothing is written until the final press, and that press writes once.
 */
import { useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import { trailerTypeLabel, type LocalTrailer, type TrailerDetails, type TrailerType } from "../shift/trailer";
import { BackButton, FormSection, formStyles, keyboardSafeScrollProps } from "./vehicleForm";
import { TrailerFields, trailerDetailsFrom } from "./trailerForm";
import { colors, spacing, typography } from "../theme/index";

interface ChangeTrailerScreenProps {
  /** The trailer in use — the one being handed back. */
  current: LocalTrailer;
  onLeave: () => void;
  /** Store the change; `null` is No trailer. Rejects if it could not be stored. */
  onConfirm: (next: TrailerDetails | null) => Promise<void>;
}

type Step =
  | { kind: "next" }
  | { kind: "new" }
  | { kind: "none" };

export function ChangeTrailerScreen({ current, onLeave, onConfirm }: ChangeTrailerScreenProps) {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>({ kind: "next" });
  const [newNumber, setNewNumber] = useState("");
  const [newType, setNewType] = useState<TrailerType | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** ONE change, however many taps — set synchronously, before any re-render. */
  const inFlight = useRef(false);

  function confirm(next: TrailerDetails | null) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    onConfirm(next).then(undefined, () => {
      inFlight.current = false;
      setSubmitting(false);
    });
  }

  const ending = (
    <FormSection label="ENDING TRAILER">
      <View style={styles.trailer}>
        <Text style={styles.number} testID="ending-trailer">{current.trailerNumber}</Text>
        <Text style={styles.meta}>{trailerTypeLabel(current.trailerType)}</Text>
      </View>
    </FormSection>
  );

  let body: React.ReactNode;
  if (step.kind === "next") {
    body = (
      <>
        {ending}
        <FormSection label="ANOTHER TRAILER">
          <OptionRow
            testID="use-different-trailer"
            title="Use a different trailer"
            detail="Enter its number and type"
            last
            onPress={() => { setStep({ kind: "new" }); }}
          />
        </FormSection>
        <FormSection label="NO TRAILER">
          <OptionRow
            testID="use-no-trailer"
            title="No trailer"
            detail="Carry on without a trailer"
            last
            onPress={() => { setStep({ kind: "none" }); }}
          />
        </FormSection>
      </>
    );
  } else if (step.kind === "new") {
    const next = trailerDetailsFrom(newNumber, newType);
    body = (
      <>
        <TrailerFields trailerNumber={newNumber} onTrailerNumber={setNewNumber} trailerType={newType} onTrailerType={setNewType} />
        <View style={formStyles.action}>
          <PrimaryButton
            label="Change Trailer"
            onPress={() => { if (next !== null) confirm(next); }}
            disabled={next === null}
            submitting={submitting}
            testID="change-trailer-confirm"
          />
        </View>
      </>
    );
  } else {
    body = (
      <>
        {ending}
        <Text style={styles.hint} testID="no-trailer-detail">
          {`${current.trailerNumber} is recorded as used. Your shift and your vehicle carry on, and you can add a trailer whenever you take one.`}
        </Text>
        <View style={formStyles.action}>
          <PrimaryButton
            label="Continue Without a Trailer"
            onPress={() => { confirm(null); }}
            submitting={submitting}
            testID="no-trailer-confirm"
          />
        </View>
      </>
    );
  }

  return (
    <View style={formStyles.screen}>
      <ScrollView
        testID="change-trailer-scroll"
        style={formStyles.screen}
        contentContainerStyle={[
          formStyles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        {...keyboardSafeScrollProps}
      >
        <BackButton testID="change-trailer-back" onPress={step.kind === "next" ? onLeave : () => { setStep({ kind: "next" }); }} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">Change Trailer</Text>
        {body}
      </ScrollView>
    </View>
  );
}

/** A choice that moves the flow on — the whole row is the target. */
function OptionRow({ testID, title, detail, last, onPress }: {
  testID: string; title: string; detail: string; last: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      style={({ pressed }) => [styles.row, last ? null : formStyles.optionDivided, pressed ? formStyles.optionPressed : null]}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.meta}>{detail}</Text>
      </View>
      <View style={styles.rowChevron} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trailer: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
  number: { fontSize: 22, fontWeight: "800", color: colors.text, letterSpacing: 0.5 },
  meta: { fontSize: 15, color: colors.textMuted },
  hint: { ...typography.helper, marginTop: -spacing.md, marginBottom: spacing.lg, marginHorizontal: spacing.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 64,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 18, fontWeight: "700", color: colors.text, letterSpacing: 0.3 },
  rowChevron: {
    width: 10,
    height: 10,
    borderRightWidth: 2.5,
    borderTopWidth: 2.5,
    borderColor: colors.textMuted,
    transform: [{ rotate: "45deg" }],
  },
});
