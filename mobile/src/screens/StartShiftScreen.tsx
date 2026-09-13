/**
 * Start Shift: the minimum a driver must say to begin a working day.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SELECTION IS NOT AUTHORITY, AND STARTING IS NOT SUBMITTING (D28)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Choosing a company records an INTENDED DESTINATION for a record that is
 * created locally and shared later, explicitly. Pressing Start Shift writes a
 * local document and nothing else: no tenant token, no `POST /shifts/start`,
 * no `POST /auth/switch-company`, no waiting on a network a loading bay does
 * not have. See `shift/localShift.ts`.
 *
 * A VEHICLE IS OPTIONAL, and that is a domain rule. A driver books on at 06:00
 * and may not be handed a truck until 08:00; that is one day starting at 06:00,
 * not a day that has not started and not a day with a placeholder vehicle. So
 * "Not yet" is a complete answer, the shift goes active without a vehicle, and
 * "shift started" is NOT a synonym for "vehicle checked" — checks belong to a
 * vehicle and arrive with the Active Shift flow.
 *
 * WHAT IS DELIBERATELY ABSENT: trailer, checks, defects, fuel, AdBlue, notes,
 * signatures. Start Shift asks four things and stops.
 *
 * HIDDEN FIELDS DO NOT LEAK. The vehicle is read from state only on the "Yes"
 * branch, so answering Yes, typing a plate and switching to "Not yet" carries
 * nothing into the shift: the driver cannot see those fields any more, so they
 * cannot be agreeing to them.
 */
import { useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import type { AccountMembership } from "../api/account";
import {
  VEHICLE_CLASSES,
  type LocalVehicle,
  type VehicleClass,
  type WorkingContext,
} from "../shift/localShift";
import { colors, radius, sizing, spacing, typography } from "../theme/index";

const PERSONAL: WorkingContext = { kind: "personal" };

/** Unanswered is a real state: it is why Start Shift begins unavailable. */
type VehicleAnswer = "unanswered" | "yes" | "not-yet";

interface StartShiftScreenProps {
  /** The driver's ACTIVE memberships, as the authenticated account reports them. */
  memberships: AccountMembership[];
  onBack: () => void;
  /** Create the day. Local only — it cannot fail for want of a network. */
  onStart: (input: { workingFor: WorkingContext; startedAt: Date; vehicle: LocalVehicle | null }) => void;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** Hours 00–23 / minutes 00–59, and nothing else. */
function parseClockPart(raw: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(raw.trim())) return null;
  const value = Number(raw);
  return value >= 0 && value <= max ? value : null;
}

/**
 * A whole, non-negative mileage.
 *
 * Digits only: an odometer reads whole miles, and allowing `12.5`, `1e4` or a
 * minus sign would only widen what can be written into a payroll record.
 * `0` is valid — a new vehicle genuinely reads zero.
 */
function parseMileage(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function StartShiftScreen({ memberships, onBack, onStart }: StartShiftScreenProps) {
  const insets = useSafeAreaInsets();
  const [working, setWorking] = useState<WorkingContext>(PERSONAL);

  /**
   * The clock is read ONCE, when the screen opens.
   *
   * A start time that crept forward while the driver filled in a plate would
   * be a different working day from the one they booked on for, so this is
   * seeded from a ref rather than recomputed on render.
   */
  const openedAt = useRef(new Date());
  const [hours, setHours] = useState(() => twoDigits(openedAt.current.getHours()));
  const [minutes, setMinutes] = useState(() => twoDigits(openedAt.current.getMinutes()));

  const [vehicleAnswer, setVehicleAnswer] = useState<VehicleAnswer>("unanswered");
  const [vehicleClass, setVehicleClass] = useState<VehicleClass | null>(null);
  const [numberPlate, setNumberPlate] = useState("");
  const [mileage, setMileage] = useState("");

  const hour = parseClockPart(hours, 23);
  const minute = parseClockPart(minutes, 59);
  const plate = numberPlate.trim().toUpperCase();
  const miles = parseMileage(mileage);

  const vehicle: LocalVehicle | null =
    vehicleAnswer === "yes" && vehicleClass !== null && plate !== "" && miles !== null
      ? { vehicleClass, numberPlate: plate, startMileage: miles }
      : null;

  const timeIsValid = hour !== null && minute !== null;
  const canStart = timeIsValid
    && (vehicleAnswer === "not-yet" || (vehicleAnswer === "yes" && vehicle !== null));

  function start() {
    if (!canStart || hour === null || minute === null) return;
    const startedAt = new Date(openedAt.current);
    startedAt.setHours(hour, minute, 0, 0);
    // `vehicle` is null on the "Not yet" branch by construction, so nothing
    // typed and then hidden can travel with the shift.
    onStart({ workingFor: working, startedAt, vehicle });
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        testID="start-shift-scroll"
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        // THE KEYBOARD MUST NOT SIT ON THE FIELD BEING TYPED INTO. Number
        // plate and Start mileage are near the bottom of a long form, so
        // without this the keyboard covers them and the driver types blind.
        //
        // iOS insets the scroll content by the keyboard's height and brings
        // the focused field into view; Android's window is already resized
        // (`adjustResize`), so the same scroll view shrinks there by itself.
        // One prop, no measured heights, no device-specific offsets, and no
        // permanent padding that would leave a hole when the keyboard is down.
        automaticallyAdjustKeyboardInsets
        // Dragging the form puts the keyboard away — the platform convention,
        // and the one Login and Registration already use.
        keyboardDismissMode="on-drag"
        // A tap no control handles closes the keyboard instead of being
        // swallowed, so the first tap on a choice row still selects it.
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={onBack}
          testID="start-shift-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
          style={styles.back}
        >
          <View style={styles.chevron} />
          <Text style={styles.backLabel}>Back</Text>
        </Pressable>

        <Text style={styles.title} testID="screen-title" accessibilityRole="header">Start Shift</Text>

        <Section label="WORKING FOR">
          <View testID="working-for" accessibilityRole="radiogroup">
            <Choice
              testID="working-for-personal"
              label="Personal"
              selected={working.kind === "personal"}
              onSelect={() => { setWorking(PERSONAL); }}
              last={memberships.length === 0}
            />
            {memberships.map((membership, index) => (
              <Choice
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
        </Section>

        <Section label="START TIME">
          <View style={styles.clock} testID="start-time">
            <ClockField testID="start-time-hours" label="Hours" value={hours} onChange={setHours} invalid={hour === null} />
            <Text style={styles.clockSeparator}>:</Text>
            <ClockField testID="start-time-minutes" label="Minutes" value={minutes} onChange={setMinutes} invalid={minute === null} />
          </View>
          <Text style={styles.hint}>
            Set to now. Change it if you started earlier — this is the time that goes on your timesheet.
          </Text>
        </Section>

        <Section label="DO YOU HAVE A VEHICLE?">
          <View testID="vehicle-question" accessibilityRole="radiogroup">
            <Choice
              testID="vehicle-yes"
              label="Yes"
              selected={vehicleAnswer === "yes"}
              onSelect={() => { setVehicleAnswer("yes"); }}
              last={false}
            />
            {/* "Not yet", not "No": a vehicle may still arrive later today. */}
            <Choice
              testID="vehicle-not-yet"
              label="Not yet"
              selected={vehicleAnswer === "not-yet"}
              onSelect={() => { setVehicleAnswer("not-yet"); }}
              last
            />
          </View>
        </Section>

        {vehicleAnswer === "yes" ? (
          <>
            <Section label="VEHICLE">
              <View accessibilityRole="radiogroup">
                {VEHICLE_CLASSES.map((option, index) => (
                  <Choice
                    key={option.id}
                    testID={`vehicle-class-${option.id}`}
                    label={option.label}
                    selected={vehicleClass === option.id}
                    onSelect={() => { setVehicleClass(option.id); }}
                    last={index === VEHICLE_CLASSES.length - 1}
                  />
                ))}
              </View>
            </Section>

            <Section label="NUMBER PLATE">
              <TextInput
                testID="number-plate"
                value={numberPlate}
                onChangeText={setNumberPlate}
                placeholder="AB24 XYZ"
                placeholderTextColor={colors.placeholder}
                // Upper-cased when the shift is created rather than while
                // typing, so the caret cannot jump in the middle of a word.
                autoCapitalize="characters"
                autoCorrect={false}
                // No UK format is imposed: plates are international.
                style={styles.input}
                accessibilityLabel="Number plate"
              />
            </Section>

            <Section label="START MILEAGE">
              <TextInput
                testID="start-mileage"
                value={mileage}
                onChangeText={setMileage}
                placeholder="0"
                placeholderTextColor={colors.placeholder}
                keyboardType="number-pad"
                style={styles.input}
                accessibilityLabel="Start mileage"
              />
            </Section>
          </>
        ) : null}

        <View style={styles.action}>
          <PrimaryButton
            label="Start Shift"
            onPress={start}
            disabled={!canStart}
            testID="start-shift-submit"
          />
        </View>
      </ScrollView>
    </View>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

/** Two digits, large enough to hit with gloves on. */
function ClockField({ testID, label, value, onChange, invalid }: {
  testID: string; label: string; value: string; onChange: (next: string) => void; invalid: boolean;
}) {
  return (
    <TextInput
      testID={testID}
      value={value}
      onChangeText={onChange}
      keyboardType="number-pad"
      maxLength={2}
      selectTextOnFocus
      accessibilityLabel={label}
      style={[styles.clockInput, invalid ? styles.clockInvalid : null]}
    />
  );
}

/**
 * One choice in a single-selection group.
 *
 * The whole row is the target rather than the tick: this is pressed with cold
 * hands before dawn, so the row is 60pt tall and the tick is feedback rather
 * than something to aim at.
 */
function Choice({ testID, label, selected, onSelect, last }: {
  testID: string; label: string; selected: boolean; onSelect: () => void; last: boolean;
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
        {selected ? <View style={styles.checkMark} /> : null}
      </View>
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

  section: { marginBottom: spacing.xl },
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
    marginTop: -3,
  },
  optionLabel: { flex: 1, fontSize: 17, color: colors.text },
  optionLabelOn: { fontWeight: "700", color: colors.brandDark },

  clock: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingVertical: spacing.lg },
  clockInput: {
    width: 84,
    minHeight: 64,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.field,
    backgroundColor: colors.surface,
    textAlign: "center",
    fontSize: 30,
    fontWeight: "700",
    color: colors.brandDark,
  },
  clockInvalid: { borderColor: colors.danger, backgroundColor: colors.dangerBg },
  clockSeparator: { fontSize: 30, fontWeight: "700", color: colors.brandDark, marginHorizontal: spacing.md },

  input: {
    minHeight: sizing.control,
    paddingHorizontal: spacing.lg,
    fontSize: 17,
    color: colors.text,
  },
  hint: { ...typography.helper, marginTop: spacing.sm, marginHorizontal: spacing.xs },

  action: { marginTop: spacing.sm },
});
