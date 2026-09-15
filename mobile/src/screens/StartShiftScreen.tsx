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
import { View, Text, TextInput, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import type { AccountMembership } from "../api/account";
import type { VehicleClass, VehicleDetails, WorkingContext } from "../shift/localShift";
import {
  BackButton,
  Choice,
  FormSection,
  VehicleFields,
  formStyles,
  keyboardSafeScrollProps,
  vehicleDetailsFrom,
} from "./vehicleForm";
import { colors, radius, spacing, typography } from "../theme/index";

const PERSONAL: WorkingContext = { kind: "personal" };

/** Unanswered is a real state: it is why Start Shift begins unavailable. */
type VehicleAnswer = "unanswered" | "yes" | "not-yet";

interface StartShiftScreenProps {
  /** The driver's ACTIVE memberships, as the authenticated account reports them. */
  memberships: AccountMembership[];
  onBack: () => void;
  /** Create the day. Local only — it cannot fail for want of a network. */
  onStart: (input: { workingFor: WorkingContext; startedAt: Date; vehicle: VehicleDetails | null }) => void;
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
  // Read only on the "Yes" branch, so fields filled in and then hidden by
  // answering "Not yet" cannot travel with the shift.
  const vehicle: VehicleDetails | null =
    vehicleAnswer === "yes" ? vehicleDetailsFrom(vehicleClass, numberPlate, mileage) : null;

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
    <View style={formStyles.screen}>
      <ScrollView
        testID="start-shift-scroll"
        style={formStyles.screen}
        contentContainerStyle={[
          formStyles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        // Keeps Number plate and Start mileage above the keyboard — see
        // `keyboardSafeScrollProps` for why these, and why nothing measured.
        {...keyboardSafeScrollProps}
      >
        <BackButton testID="start-shift-back" onPress={onBack} />

        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">Start Shift</Text>

        <FormSection label="WORKING FOR">
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
        </FormSection>

        <FormSection label="START TIME">
          <View style={styles.clock} testID="start-time">
            <ClockField testID="start-time-hours" label="Hours" value={hours} onChange={setHours} invalid={hour === null} />
            <Text style={styles.clockSeparator}>:</Text>
            <ClockField testID="start-time-minutes" label="Minutes" value={minutes} onChange={setMinutes} invalid={minute === null} />
          </View>
          <Text style={styles.hint}>
            Set to now. Change it if you started earlier — this is the time that goes on your timesheet.
          </Text>
        </FormSection>

        <FormSection label="DO YOU HAVE A VEHICLE?">
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
        </FormSection>

        {vehicleAnswer === "yes" ? (
          <VehicleFields
            vehicleClass={vehicleClass}
            onVehicleClass={setVehicleClass}
            numberPlate={numberPlate}
            onNumberPlate={setNumberPlate}
            mileage={mileage}
            onMileage={setMileage}
          />
        ) : null}

        <View style={formStyles.action}>
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


const styles = StyleSheet.create({
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

  hint: { ...typography.helper, marginTop: spacing.sm, marginHorizontal: spacing.xs },
});
