/**
 * Finish Shift — the end of the driver's working day.
 *
 * With a vehicle in use:  Final Mileage → Finish Details → Review → Finish Shift
 * With none in use:                       Finish Details → Review → Finish Shift
 *
 * NOTHING IS WRITTEN UNTIL THE LAST PRESS. The steps hold what the driver
 * enters on screen only; Back walks them and keeps it. The Review shows the
 * day exactly as it will be saved — built by the store's own `completedFrom`,
 * with the vehicle and trailer in use ending at the declared finish — while
 * the stored day is left as it is.
 *
 * The finish is a DECLARED date and time, both set to when the flow opened
 * and both freely changed: the day is chosen explicitly, never guessed from
 * the time, so a shift that crossed midnight — or several — finishes on the
 * day the driver says. It may not precede anything the day already holds
 * (`earliestFinish`): such a time is explained and the driver corrects it —
 * it is never moved for them. It MAY be later than now (D40); more than 15
 * minutes ahead of the clock at the final press is confirmed, never refused
 * (`confirmFinishAhead`).
 *
 * Checks not completed do not stop a finish. The Review says which, once, and
 * shows each use's check exactly as stored: nothing is marked done for the
 * driver.
 */
import { useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import {
  SHIFT_NOTES_MAX_LENGTH,
  completedFrom,
  earliestFinish,
  timesheetVersion,
  type FinishBoundary,
  type LocalShift,
  type ShiftFinish,
} from "../shift/localShift";
import { classLabel, formatDateTime, formatMileage } from "./format";
import { DayStepper, TimeOfDayFields, timeStyles, useTimeOfDay } from "./timeOfDay";
import { confirmFinishAhead } from "./confirmFinishAhead";
import { FinalDeclaration } from "./FinalDeclaration";
import { TimesheetSummary } from "./TimesheetSummary";
import { BackButton, Choice, FormSection, formStyles, keyboardSafeScrollProps, parseMileage } from "./vehicleForm";
import { colors, spacing, typography } from "../theme/index";

export interface FinishShiftScreenProps {
  /** The open day, as the route last read it — re-read whenever the flow comes back into view. */
  shift: LocalShift;
  /** When the flow opened: the finish date and time start here. */
  openedAt: Date;
  /** The device's time now — read at every check, never kept. */
  now?: () => Date;
  /** Leave without finishing. */
  onLeave: () => void;
  /**
   * Finish the day, declared as `version` — the version the Review showed
   * (`timesheetVersion`). Rejects if it could not be finished; the Review stays open.
   */
  onConfirm: (finish: ShiftFinish, version: string) => Promise<void>;
  /** Correct who the day is for, and when it started (D41). */
  onEditShift: () => void;
  /** Open one vehicle use of the day — in use, or ended — by its identity (D41). */
  onOpenVehicleUse: (useId: string, inUse: boolean) => void;
  /** Open one trailer use of the day — in use, or ended — by its identity (D41). */
  onOpenTrailerUse: (useId: string, inUse: boolean) => void;
}

type Step = "mileage" | "details" | "review";

export function FinishShiftScreen({
  shift, openedAt, now = () => new Date(), onLeave, onConfirm, onEditShift, onOpenVehicleUse, onOpenTrailerUse,
}: FinishShiftScreenProps) {
  const insets = useSafeAreaInsets();
  const current = shift.vehicle;
  const firstStep: Step = current === null ? "details" : "mileage";

  const [step, setStep] = useState<Step>(firstStep);
  const [mileageText, setMileageText] = useState("");
  const time = useTimeOfDay(() => openedAt);
  /** Days from the day the flow opened: 0 is that day, -1 the day before. */
  const [dayOffset, setDayOffset] = useState(0);
  const [nightOut, setNightOut] = useState<boolean | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** ONE confirmation, however many taps — set synchronously, before any re-render. */
  const inFlight = useRef(false);
  /**
   * The version the driver declared correct — the exact record the Review
   * shows, as JSON — or `null`. The declaration holds only while the Review
   * still shows that version, and is cleared whenever the driver leaves the
   * Review to correct anything: a declaration is never carried to a record
   * the driver has not seen (D41).
   */
  const [declaredFor, setDeclaredFor] = useState<string | null>(null);

  const finalMileage = current === null ? null : parseMileage(mileageText);
  const mileageBelowStart = current !== null && finalMileage !== null && finalMileage < current.startMileage;
  const mileageValid = current === null || (finalMileage !== null && !mileageBelowStart);

  const finishDay = new Date(openedAt);
  finishDay.setDate(finishDay.getDate() + dayOffset);
  const endedAt = time.at(finishDay);
  const earliest = earliestFinish(shift);
  const tooEarly = endedAt !== null && endedAt.getTime() < Date.parse(earliest.at);
  const detailsValid = endedAt !== null && !tooEarly && nightOut !== null;

  const finish: ShiftFinish | null = mileageValid && detailsValid && endedAt !== null && nightOut !== null
    ? { finalMileage, endedAt, nightOut, notes }
    : null;

  /** Leave the Review to correct something: the declaration does not come with it. */
  function correct(then: () => void) {
    setDeclaredFor(null);
    then();
  }

  function back() {
    setDeclaredFor(null);
    if (step === "review") setStep("details");
    else if (step === "details" && firstStep === "mileage") setStep("mileage");
    else onLeave();
  }

  function confirm() {
    if (finish === null || inFlight.current) return;
    // Held from the first press: no second confirmation, and no second
    // finish, while the first is being asked about or saved.
    inFlight.current = true;
    const release = () => { inFlight.current = false; };
    const proceed = () => {
      setSubmitting(true);
      // On success the route navigates away. On failure the day is as it was
      // and the driver can simply try again.
      onConfirm(finish, timesheetVersion(completedFrom(shift, finish))).then(undefined, () => {
        release();
        setSubmitting(false);
      });
    };
    // Against the clock NOW, at the press — never when the flow opened.
    if (!confirmFinishAhead(finish.endedAt, now(), proceed, release)) proceed();
  }

  let body: React.ReactNode;
  if (step === "mileage" && current !== null) {
    body = (
      <>
        <FormSection label={current.vehicleClass === "class1" ? "UNIT" : "VEHICLE"}>
          <View style={styles.vehicle}>
            <Text style={styles.plate} testID="finish-vehicle-plate">{current.numberPlate}</Text>
            <Text style={styles.meta}>
              {`${classLabel(current.vehicleClass)} · start mileage ${formatMileage(current.startMileage)}`}
            </Text>
          </View>
        </FormSection>
        <FormSection label="FINAL MILEAGE">
          <TextInput
            testID="final-mileage"
            value={mileageText}
            onChangeText={setMileageText}
            placeholder={String(current.startMileage)}
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            style={formStyles.input}
            accessibilityLabel="Final mileage"
          />
        </FormSection>
        {mileageBelowStart ? (
          <Text style={styles.error} testID="final-mileage-error">
            {`Can't be less than the start mileage, ${formatMileage(current.startMileage)}.`}
          </Text>
        ) : null}
        <View style={formStyles.action}>
          <PrimaryButton
            label="Continue"
            onPress={() => { if (mileageValid && finalMileage !== null) setStep("details"); }}
            disabled={!mileageValid || finalMileage === null}
            testID="finish-mileage-continue"
          />
        </View>
      </>
    );
  } else if (step === "details" || finish === null) {
    body = (
      <>
        <FormSection label="FINISH DATE AND TIME">
          <DayStepper testID="finish-date" day={finishDay} today={openedAt} onStep={by => { setDayOffset(dayOffset + by); }} />
          <TimeOfDayFields testID="finish-time" time={time} />
        </FormSection>
        {tooEarly ? (
          <Text style={styles.error} testID="finish-time-error">
            {`Can't be before ${formatDateTime(earliest.at)} — when ${boundaryText(earliest.because)}.`}
          </Text>
        ) : (
          <Text style={[timeStyles.hint, styles.hint]}>
            Set to now. Change it if you finished earlier — this is the time that goes on your timesheet.
          </Text>
        )}
        <FormSection label="NIGHT OUT">
          <Choice testID="night-out-yes" label="Yes" selected={nightOut === true} onSelect={() => { setNightOut(true); }} last={false} />
          <Choice testID="night-out-no" label="No" selected={nightOut === false} onSelect={() => { setNightOut(false); }} last />
        </FormSection>
        <FormSection label="NOTES (OPTIONAL)">
          <TextInput
            testID="shift-notes"
            value={notes}
            onChangeText={setNotes}
            placeholder="Anything to note about today"
            placeholderTextColor={colors.placeholder}
            maxLength={SHIFT_NOTES_MAX_LENGTH}
            multiline
            style={[formStyles.input, styles.notes]}
            accessibilityLabel="Notes"
          />
        </FormSection>
        <View style={formStyles.action}>
          <PrimaryButton
            label="Review"
            onPress={() => { if (finish !== null) setStep("review"); }}
            disabled={finish === null}
            testID="finish-details-continue"
          />
        </View>
      </>
    );
  } else {
    const day = completedFrom(shift, finish);
    const version = JSON.stringify(day);
    body = (
      <>
        <TimesheetSummary
          day={day}
          inUse={{ vehicle: shift.vehicle?.useId ?? null, trailer: shift.trailer?.useId ?? null }}
          corrections={{
            onEditShift: () => { correct(onEditShift); },
            onEditDetails: () => { correct(() => { setStep("details"); }); },
            onEditFinalMileage: () => { correct(() => { setStep("mileage"); }); },
            onOpenVehicle: useId => { correct(() => { onOpenVehicleUse(useId, shift.vehicle?.useId === useId); }); },
            onOpenTrailer: useId => { correct(() => { onOpenTrailerUse(useId, shift.trailer?.useId === useId); }); },
          }}
        />
        <FinalDeclaration
          workingFor={day.workingFor}
          confirmed={declaredFor === version}
          onToggle={() => { setDeclaredFor(declaredFor === version ? null : version); }}
          submitting={submitting}
          onConfirm={() => { if (declaredFor === version) confirm(); }}
          testID="finish-confirm"
        />
      </>
    );
  }

  return (
    <View style={formStyles.screen}>
      <ScrollView
        testID="finish-shift-scroll"
        style={formStyles.screen}
        contentContainerStyle={[
          formStyles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        {...keyboardSafeScrollProps}
      >
        <BackButton testID="finish-back" onPress={back} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">Finish Shift</Text>
        {body}
      </ScrollView>
    </View>
  );
}

/** Why a finish cannot be earlier — what the driver will recognise. */
function boundaryText(because: FinishBoundary): string {
  switch (because.kind) {
    case "shift":         return "the shift started";
    case "vehicle":       return `${because.numberPlate} started`;
    case "trailer":       return `trailer ${because.trailerNumber} started`;
    case "ended-vehicle": return `${because.numberPlate} was handed back`;
    case "ended-trailer": return `trailer ${because.trailerNumber} was handed back`;
  }
}

const styles = StyleSheet.create({
  vehicle: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
  plate: { fontSize: 22, fontWeight: "800", color: colors.text, letterSpacing: 0.5 },
  meta: { fontSize: 15, color: colors.textMuted },
  error: { ...typography.error, marginTop: -spacing.md, marginBottom: spacing.lg, marginLeft: spacing.xs },
  hint: { marginTop: -spacing.md, marginBottom: spacing.lg },
  notes: { minHeight: 88, paddingTop: spacing.md, textAlignVertical: "top" },
});
