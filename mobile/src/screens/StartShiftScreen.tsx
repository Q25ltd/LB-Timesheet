/**
 * Start Shift, step one: who the day is being worked for.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SELECTION IS NOT AUTHORITY — read this before adding anything here
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The driver's working timesheet is LOCAL and PERSONAL while the day is being
 * worked. Choosing a company on this screen records an INTENDED DESTINATION
 * for a record that does not exist yet, and it does not:
 *
 *   - mint a tenant token, or call `POST /auth/switch-company`;
 *   - create a server Shift, or call `POST /shifts/start`;
 *   - tell the company anything, or create any ownership over the day.
 *
 * The day is created locally first and shared explicitly later. When the driver
 * eventually chooses to SEND a finished timesheet, the server validates the
 * membership, decides the company's destination, and does the delivery — the
 * phone is never the authority for any of that.
 *
 * This screen therefore makes NO network request at all, and the test suite
 * proves it by asserting zero `fetch` calls rather than by checking which URLs
 * were avoided.
 *
 * PERSONAL IS THE DEFAULT, always, on every new Start Shift. Not "unless the
 * driver has one company", not "unless they picked one yesterday", not
 * "unless a tenant token happens to exist". A driver working for themselves
 * touches nothing; working for a company costs exactly one tap. That asymmetry
 * is the product decision (D27), not an accident of implementation.
 *
 * SINGLE SELECTION, drawn as ticks. The control reads as a checklist to a
 * driver and behaves as a radio group: exactly one of Personal or one active
 * company, never two, never none. `accessibilityRole="radio"` is what carries
 * that meaning to a screen reader, whatever the tick looks like.
 *
 * WHAT IS NOT HERE, deliberately: start time, vehicle class, registration,
 * odometer, trailer, checks, defects, fuel. They belong to later steps, and
 * `Continue` is disabled because there is nowhere honest for it to go yet.
 */
import { useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import type { AccountMembership } from "../api/account";
import { colors, radius, sizing, spacing, typography } from "../theme/index";

/**
 * Who the day is being worked for.
 *
 * A company option carries the membership's own identity rather than a bare
 * name, so a later step can act on the driver's real relationship without
 * having to match a string back to an account. It is still only a local
 * intention — see this file's header.
 */
export type WorkingContext =
  | { kind: "personal" }
  | { kind: "company"; membershipId: string; companyId: string; companyName: string };

const PERSONAL: WorkingContext = { kind: "personal" };

interface StartShiftScreenProps {
  /** The driver's ACTIVE memberships, as the authenticated account reports them. */
  memberships: AccountMembership[];
  /** Leave the workflow. */
  onBack: () => void;
}

export function StartShiftScreen({ memberships, onBack }: StartShiftScreenProps) {
  const insets = useSafeAreaInsets();
  const [working, setWorking] = useState<WorkingContext>(PERSONAL);

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: spacing.xxl },
        ]}
      >
        <Pressable
          onPress={onBack}
          testID="start-shift-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
          style={styles.back}
        >
          {/* A chevron drawn from a rotated square's two borders — the same
              no-dependency approach the tab icons take. */}
          <View style={styles.chevron} />
          <Text style={styles.backLabel}>Back</Text>
        </Pressable>

        <Text style={styles.title} testID="screen-title" accessibilityRole="header">Start Shift</Text>

        <Text style={styles.sectionLabel}>WORKING FOR</Text>

        <View style={styles.card} testID="working-for" accessibilityRole="radiogroup">
          <Option
            testID="working-for-personal"
            label="Personal"
            selected={working.kind === "personal"}
            onSelect={() => { setWorking(PERSONAL); }}
            last={memberships.length === 0}
          />
          {memberships.map((membership, index) => (
            <Option
              key={membership.membershipId}
              testID={`working-for-${membership.membershipId}`}
              label={membership.companyName}
              selected={working.kind === "company" && working.membershipId === membership.membershipId}
              last={index === memberships.length - 1}
              onSelect={() => {
                setWorking({
                  kind:         "company",
                  membershipId: membership.membershipId,
                  companyId:    membership.companyId,
                  companyName:  membership.companyName,
                });
              }}
            />
          ))}
        </View>

        {/* Disabled because step two does not exist. No explanatory line: a
            disabled primary action is already unambiguous, and an apology
            under every unfinished control does not scale. */}
        <View style={styles.action}>
          <PrimaryButton label="Continue" disabled testID="start-shift-continue" />
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * One choice in the group.
 *
 * A whole row is the target rather than the tick itself — this is pressed with
 * cold hands before dawn, so the row is 60pt tall and the tick is feedback
 * rather than something to aim at.
 */
function Option({ testID, label, selected, onSelect, last }: {
  testID: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  last: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onSelect}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.option,
        last ? null : styles.optionDivided,
        pressed ? styles.optionPressed : null,
      ]}
    >
      <View style={[styles.tick, selected ? styles.tickOn : null]}>
        {/* The check: two borders of a rotated box, so there is no glyph font
            and no icon package involved. */}
        {selected ? <View style={styles.checkMark} /> : null}
      </View>
      {/* Wraps rather than truncates: a long haulier name must stay readable. */}
      <Text style={[styles.optionLabel, selected ? styles.optionLabelOn : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, paddingHorizontal: spacing.xl },

  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: sizing.minTouch,
    alignSelf: "flex-start",
  },
  chevron: {
    width: 10,
    height: 10,
    borderLeftWidth: 2.5,
    borderBottomWidth: 2.5,
    borderColor: colors.brandLight,
    transform: [{ rotate: "45deg" }],
  },
  backLabel: { color: colors.brandLight, fontWeight: "700", fontSize: 16 },

  title: { ...typography.title, marginTop: spacing.sm, marginBottom: spacing.xl },
  sectionLabel: {
    ...typography.label,
    letterSpacing: 1,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    // Well beyond the 44pt minimum: this is the screen's whole interaction.
    minHeight: 60,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  optionDivided: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  optionPressed: { backgroundColor: colors.surfaceAccent },
  tick: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  tickOn: { borderColor: colors.brandLight, backgroundColor: colors.brandLight },
  checkMark: {
    width: 11,
    height: 6,
    borderLeftWidth: 2.5,
    borderBottomWidth: 2.5,
    borderColor: colors.onBrand,
    transform: [{ rotate: "-45deg" }],
    // The rotated box sits low in its own frame; lift it onto the optical centre.
    marginTop: -3,
  },
  // `flex: 1` so a long company name wraps inside the row instead of pushing
  // the tick out of the card.
  optionLabel: { flex: 1, fontSize: 17, color: colors.text },
  optionLabelOn: { fontWeight: "700", color: colors.brandDark },

  action: { marginTop: spacing.xl },
});
