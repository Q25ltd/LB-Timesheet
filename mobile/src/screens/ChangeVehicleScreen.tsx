/**
 * Change Unit / Change Vehicle — end the vehicle in use and take the next.
 *
 * A driver hands back AB12 CDE at 09:00 and takes XY34 ZZZ. Two facts close
 * the first — the odometer reading, and the moment — and the second begins as
 * a NEW use with its own start mileage and its own checks (`changeVehicle`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NOTHING IS WRITTEN UNTIL THE CHANGE IS CONFIRMED
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The flow is a few steps — end mileage, which vehicle next, that vehicle's
 * start mileage — held on this screen alone. Opening it, typing into it and
 * backing out of it change nothing: the vehicle in use stays in use, with no
 * end recorded, until the final press. That press writes the whole change at
 * once, so there is never a day whose old vehicle has ended and whose next has
 * not begun.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE NEXT VEHICLE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * USED THIS SHIFT comes first, because drivers go back to trucks they had
 * earlier: one entry per vehicle, most recently used first, never the one
 * being ended (`usedThisShift`). Choosing one reuses its class and plate —
 * and nothing else. Its start mileage is asked afresh, because someone else
 * may have moved it, and the driver says whether to check it again: it may
 * have been used or changed while they were away, so an earlier check is not
 * carried across, and "No" means "not now", never "reuse the old one".
 *
 * A different vehicle is entered as Start Shift and Add Vehicle enter one —
 * the same fields and rules (`vehicleForm.tsx`) — and starts, like any new
 * vehicle, with its checks not completed.
 *
 * ANY CLASS MAY FOLLOW ANY CLASS. Class belongs to the use, not to the day:
 * all three are offered, with none chosen in advance, whatever is in use now,
 * and every vehicle used earlier is offered back whatever class it is. What
 * the class in use decides is the WORDING — a Class 1 is a unit and this
 * screen is Change Unit; a Class 2 or a van is a vehicle and it is Change
 * Vehicle.
 */
import { useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import {
  VEHICLE_CLASSES,
  type LocalVehicle,
  type VehicleClass,
  type VehicleDetails,
} from "../shift/localShift";
import type { UsedVehicle } from "../shift/usedVehicles";
import {
  BackButton,
  Choice,
  FormSection,
  VehicleFields,
  formStyles,
  keyboardSafeScrollProps,
  parseMileage,
  vehicleDetailsFrom,
} from "./vehicleForm";
import { formatClockTime, formatMileage } from "./format";
import { colors, spacing, typography } from "../theme/index";

/** What the driver confirms: how the vehicle in use ends, and what comes next. */
export interface VehicleChange {
  endMileage: number;
  next: VehicleDetails;
  /** Open Vehicle Checks for the next vehicle straight away. Asked only when reusing one. */
  performChecks: boolean;
}

interface ChangeVehicleScreenProps {
  /** The vehicle in use — the one being ended. */
  current: LocalVehicle;
  /** Vehicles used earlier today that it may be changed to. */
  candidates: readonly UsedVehicle[];
  /** Leave without changing anything. */
  onLeave: () => void;
  /** Store the change. Rejects if it could not be stored; the form stays open. */
  onConfirm: (change: VehicleChange) => Promise<void>;
}

type Step =
  | { kind: "end" }
  | { kind: "next" }
  | { kind: "reuse"; vehicle: UsedVehicle }
  | { kind: "new" };

function classLabel(id: VehicleClass): string {
  return VEHICLE_CLASSES.find(option => option.id === id)?.label ?? id;
}

export function ChangeVehicleScreen({ current, candidates, onLeave, onConfirm }: ChangeVehicleScreenProps) {
  const insets = useSafeAreaInsets();
  const isUnit = current.vehicleClass === "class1";
  const noun = isUnit ? "unit" : "vehicle";
  const title = isUnit ? "Change Unit" : "Change Vehicle";

  const [step, setStep] = useState<Step>({ kind: "end" });
  const [endText, setEndText] = useState("");
  const [reuseMileage, setReuseMileage] = useState("");
  const [performChecks, setPerformChecks] = useState<boolean | null>(null);
  // Asked, never assumed: the next vehicle may be any class, including one the
  // day has not used yet.
  const [newClass, setNewClass] = useState<VehicleClass | null>(null);
  const [newPlate, setNewPlate] = useState("");
  const [newMileage, setNewMileage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** ONE confirmation, however many taps — set synchronously, before any re-render. */
  const inFlight = useRef(false);

  const endMileage = parseMileage(endText);
  const endBelowStart = endMileage !== null && endMileage < current.startMileage;
  const endValid = endMileage !== null && !endBelowStart;

  function back() {
    if (step.kind === "end") onLeave();
    else if (step.kind === "next") setStep({ kind: "end" });
    else setStep({ kind: "next" });
  }

  function confirm(change: VehicleChange | null) {
    if (change === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    // On success the route navigates away. On failure nothing was stored, the
    // vehicle in use is untouched, and the driver can simply try again.
    onConfirm(change).then(undefined, () => {
      inFlight.current = false;
      setSubmitting(false);
    });
  }

  let body: React.ReactNode;
  if (step.kind === "end") {
    body = (
      <>
        <FormSection label={`ENDING ${noun.toUpperCase()}`}>
          <View style={styles.vehicle}>
            <Text style={styles.plate} testID="ending-plate">{current.numberPlate}</Text>
            <Text style={styles.meta} testID="ending-start-mileage">
              {`${classLabel(current.vehicleClass)} · start mileage ${formatMileage(current.startMileage)}`}
            </Text>
          </View>
        </FormSection>
        <FormSection label="END MILEAGE">
          <TextInput
            testID="end-mileage"
            value={endText}
            onChangeText={setEndText}
            placeholder={String(current.startMileage)}
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            style={formStyles.input}
            accessibilityLabel="End mileage"
          />
        </FormSection>
        {endBelowStart ? (
          <Text style={styles.error} testID="end-mileage-error">
            {`Can't be less than the start mileage, ${formatMileage(current.startMileage)}.`}
          </Text>
        ) : null}
        <View style={formStyles.action}>
          <PrimaryButton
            label="Continue"
            onPress={() => { if (endValid) setStep({ kind: "next" }); }}
            disabled={!endValid}
            testID="change-continue"
          />
        </View>
      </>
    );
  } else if (step.kind === "next") {
    body = (
      <>
        <Text style={styles.summary} testID="ending-summary">
          {`Ending ${current.numberPlate} at ${formatMileage(endMileage ?? current.startMileage)}`}
        </Text>
        {candidates.length > 0 ? (
          <FormSection label="USED THIS SHIFT">
            {candidates.map((vehicle, index) => (
              <OptionRow
                key={`${vehicle.vehicleClass}-${vehicle.numberPlate}`}
                testID={`candidate-${vehicle.numberPlate}`}
                title={vehicle.numberPlate}
                detail={`${classLabel(vehicle.vehicleClass)} · last used ${formatClockTime(vehicle.lastEndedAt)}`}
                last={index === candidates.length - 1}
                onPress={() => {
                  setReuseMileage("");
                  setPerformChecks(null);
                  setStep({ kind: "reuse", vehicle });
                }}
              />
            ))}
          </FormSection>
        ) : null}
        {/*
          "Vehicle" whatever is in use now: this path asks for the class, and
          the answer may be any of the three. Calling it a unit to a driver in
          a unit would promise a choice the next screen does not make.
        */}
        <FormSection label="ANOTHER VEHICLE">
          <OptionRow
            testID="use-different"
            title="Use a different vehicle"
            detail="Enter its class, number plate and start mileage"
            last
            onPress={() => { setStep({ kind: "new" }); }}
          />
        </FormSection>
      </>
    );
  } else if (step.kind === "reuse") {
    const { vehicle } = step;
    // Named for the vehicle being taken, not the one being put down: a driver
    // in a unit may be going back to this morning's van.
    const nextIsUnit = vehicle.vehicleClass === "class1";
    const startMileage = parseMileage(reuseMileage);
    const change = endMileage !== null && startMileage !== null && performChecks !== null
      ? {
          endMileage,
          next: { vehicleClass: vehicle.vehicleClass, numberPlate: vehicle.numberPlate, startMileage },
          performChecks,
        }
      : null;
    body = (
      <>
        <FormSection label={nextIsUnit ? "NEXT UNIT" : "NEXT VEHICLE"}>
          <View style={styles.vehicle}>
            <Text style={styles.plate} testID="next-plate">{vehicle.numberPlate}</Text>
            <Text style={styles.meta}>{classLabel(vehicle.vehicleClass)}</Text>
          </View>
        </FormSection>
        <FormSection label="START MILEAGE">
          <TextInput
            testID="next-start-mileage"
            value={reuseMileage}
            onChangeText={setReuseMileage}
            placeholder="0"
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            style={formStyles.input}
            accessibilityLabel="Start mileage"
          />
        </FormSection>
        <FormSection label="PERFORM VEHICLE CHECKS?">
          <View accessibilityRole="radiogroup">
            <Choice
              testID="perform-checks-yes"
              label="Yes"
              selected={performChecks === true}
              onSelect={() => { setPerformChecks(true); }}
              last={false}
            />
            <Choice
              testID="perform-checks-no"
              label="No"
              selected={performChecks === false}
              onSelect={() => { setPerformChecks(false); }}
              last
            />
          </View>
        </FormSection>
        <Text style={styles.hint}>
          It may have been used or changed while you were away. An earlier check is not carried over.
        </Text>
        <View style={formStyles.action}>
          <PrimaryButton
            label={title}
            onPress={() => { confirm(change); }}
            disabled={change === null}
            submitting={submitting}
            testID="change-confirm"
          />
        </View>
      </>
    );
  } else {
    const next = vehicleDetailsFrom(newClass, newPlate, newMileage);
    const change = endMileage !== null && next !== null ? { endMileage, next, performChecks: false } : null;
    body = (
      <>
        <VehicleFields
          vehicleClass={newClass}
          onVehicleClass={setNewClass}
          numberPlate={newPlate}
          onNumberPlate={setNewPlate}
          mileage={newMileage}
          onMileage={setNewMileage}
        />
        <View style={formStyles.action}>
          <PrimaryButton
            label={title}
            onPress={() => { confirm(change); }}
            disabled={change === null}
            submitting={submitting}
            testID="change-confirm"
          />
        </View>
      </>
    );
  }

  return (
    <View style={formStyles.screen}>
      <ScrollView
        testID="change-vehicle-scroll"
        style={formStyles.screen}
        contentContainerStyle={[
          formStyles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        // Mileage fields sit low on a phone; the keyboard must not cover them.
        {...keyboardSafeScrollProps}
      >
        <BackButton testID="change-back" onPress={back} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">{title}</Text>
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
      style={({ pressed }) => [
        styles.row,
        last ? null : formStyles.optionDivided,
        pressed ? formStyles.optionPressed : null,
      ]}
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
  vehicle: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
  plate: { fontSize: 22, fontWeight: "800", color: colors.text, letterSpacing: 0.5 },
  meta: { fontSize: 15, color: colors.textMuted },
  summary: { ...typography.subtitle, marginTop: -spacing.md, marginBottom: spacing.xl },
  error: { ...typography.error, marginTop: -spacing.md, marginBottom: spacing.lg, marginLeft: spacing.xs },
  hint: { ...typography.helper, marginTop: -spacing.md, marginBottom: spacing.lg, marginLeft: spacing.xs },
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
