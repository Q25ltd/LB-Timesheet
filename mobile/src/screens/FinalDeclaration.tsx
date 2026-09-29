/**
 * The last thing before a timesheet is saved: what the final action will do,
 * the driver's declaration, and the action itself (D41).
 *
 * The declaration — "I confirm all details are correct" — starts UNticked and
 * the action cannot be taken without it. The caller binds it to the exact
 * version on screen and clears it whenever anything is corrected. For a
 * company's day the store keeps it bound to exactly that version (D42) — never
 * as evidence for a version the driver did not see.
 *
 * WHO THE TIMESHEET IS FOR DECIDES WHAT THE ACTION MEANS.
 *   Personal  "Save Timesheet" — saved on this phone; nothing is sent.
 *   Company   the action will be "Save & Send Timesheet" once sending exists.
 *             It does not yet (D41), so this says so plainly and saves on the
 *             phone only: nothing is sent, and nothing claims it was.
 */
import { View, Text, Pressable, StyleSheet } from "react-native";
import { PrimaryButton } from "../components/PrimaryButton";
import type { WorkingContext } from "../shift/localShift";
import { formStyles } from "./vehicleForm";
import { colors, radius, spacing, typography } from "../theme/index";

const DECLARATION = "I confirm all details are correct";

/** What the final action will do, said before the driver takes it. */
function finalMeaning(workingFor: WorkingContext): { text: string; action: string } {
  if (workingFor.kind === "personal") {
    return { text: "This saves your completed timesheet on this phone. Nothing is sent.", action: "Save Timesheet" };
  }
  const name = workingFor.companyName;
  return {
    text: `Sending timesheets to ${name} isn't available yet. This saves it on this phone only — nothing is sent to ${name}.`,
    action: "Save Timesheet — Not Sent",
  };
}

export function FinalDeclaration({ workingFor, confirmed, onToggle, submitting, onConfirm, testID }: {
  workingFor: WorkingContext;
  confirmed: boolean;
  onToggle: () => void;
  submitting: boolean;
  onConfirm: () => void;
  /** The action's test id; the declaration's is `${testID}-declaration`. */
  testID: string;
}) {
  const meaning = finalMeaning(workingFor);
  return (
    <>
      <Text style={styles.meaning} testID={`${testID}-meaning`}>{meaning.text}</Text>
      <Pressable
        testID={`${testID}-declaration`}
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityLabel={DECLARATION}
        accessibilityState={{ checked: confirmed }}
        style={({ pressed }) => [styles.declaration, pressed ? formStyles.optionPressed : null]}
      >
        <View style={[styles.box, confirmed ? styles.boxOn : null]}>
          {confirmed ? <View style={styles.tick} /> : null}
        </View>
        <Text style={styles.declarationLabel}>{DECLARATION}</Text>
      </Pressable>
      <View style={formStyles.action}>
        <PrimaryButton label={meaning.action} onPress={onConfirm} disabled={!confirmed} submitting={submitting} testID={testID} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  meaning: { ...typography.helper, marginBottom: spacing.md, marginHorizontal: spacing.xs },
  declaration: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  box: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.brandLight,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: colors.brandLight },
  tick: {
    width: 12,
    height: 7,
    borderLeftWidth: 2.5,
    borderBottomWidth: 2.5,
    borderColor: colors.surface,
    transform: [{ rotate: "-45deg" }],
    marginTop: -2,
  },
  declarationLabel: { flex: 1, fontSize: 16, fontWeight: "700", color: colors.text },
});
