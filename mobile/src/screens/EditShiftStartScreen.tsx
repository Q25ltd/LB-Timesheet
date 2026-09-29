/**
 * Correct who the day in progress is worked for, and when it started — from
 * the Finish Review, before the day is finished (D41).
 *
 * The start is a date and a time, each explicit. It may not be after any use
 * of the day began: said as the driver types, refused again by the store,
 * and never worked round by moving a use (a use's start is its own time,
 * corrected on its own page). An earlier start moves nothing: a shift may
 * start before its first use (D42).
 * Choosing a company sends nothing (D28): only the final action on the
 * Review decides what happens to the timesheet.
 */
import { useRef, useState } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import type { AccountMembership } from "../api/account";
import type { LocalShift, WorkingContext } from "../shift/localShift";
import { formatDateTime } from "./format";
import { DayStepper, TimeOfDayFields, useTimeOfDay } from "./timeOfDay";
import { workingForLabel } from "./TimesheetRow";
import { keyOf, workingForOptions } from "./EditTimesheetScreen";
import { BackButton, Choice, FormSection, formStyles } from "./vehicleForm";
import { spacing, typography } from "../theme/index";

export interface ShiftStartEdit {
  workingFor: WorkingContext;
  startedAt: Date;
}

interface EditShiftStartScreenProps {
  shift: LocalShift;
  memberships: readonly AccountMembership[];
  onLeave: () => void;
  /** Save the correction. Rejects if it could not be saved; the form stays open. */
  onSave: (edit: ShiftStartEdit) => Promise<void>;
}

/** The earliest start of any use of the day — the latest the day may start. */
function firstUse(shift: LocalShift): { name: string; at: string } | null {
  const uses = [
    ...shift.previousVehicles.map(use => ({ name: use.numberPlate, at: use.startedAt })),
    ...(shift.vehicle === null ? [] : [{ name: shift.vehicle.numberPlate, at: shift.vehicle.startedAt }]),
    ...shift.previousTrailers.map(use => ({ name: `trailer ${use.trailerNumber}`, at: use.startedAt })),
    ...(shift.trailer === null ? [] : [{ name: `trailer ${shift.trailer.trailerNumber}`, at: shift.trailer.startedAt }]),
  ];
  return uses.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] ?? null;
}

export function EditShiftStartScreen({ shift, memberships, onLeave, onSave }: EditShiftStartScreenProps) {
  const insets = useSafeAreaInsets();
  const options = workingForOptions(shift.workingFor, memberships);
  const [workingFor, setWorkingFor] = useState<WorkingContext>(shift.workingFor);
  const [offset, setOffset] = useState(0);
  const time = useTimeOfDay(() => new Date(shift.startedAt));
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  const base = new Date(shift.startedAt);
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  const typed = time.at(day);
  const first = firstUse(shift);
  const tooLate = typed !== null && first !== null && typed.getTime() > Date.parse(first.at);
  // Seconds are not on the form: a start left as it was keeps its own.
  const startedAt = typed === null ? null
    : Math.floor(typed.getTime() / 60_000) === Math.floor(Date.parse(shift.startedAt) / 60_000) ? new Date(shift.startedAt) : typed;
  const unchanged = startedAt !== null && startedAt.toISOString() === shift.startedAt && keyOf(workingFor) === keyOf(shift.workingFor);
  const canSave = startedAt !== null && !tooLate && !unchanged;

  function save() {
    if (!canSave || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    onSave({ workingFor, startedAt }).then(undefined, () => {
      inFlight.current = false;
      setSubmitting(false);
    });
  }

  return (
    <View style={formStyles.screen}>
      <ScrollView
        style={formStyles.screen}
        contentContainerStyle={[formStyles.content, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl }]}
      >
        <BackButton testID="edit-shift-back" onPress={onLeave} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">Edit Shift</Text>

        <FormSection label="WORKING FOR">
          {options.map((option, index) => (
            <Choice
              key={keyOf(option)}
              testID={`edit-shift-working-for-${keyOf(option)}`}
              label={workingForLabel(option)}
              selected={keyOf(option) === keyOf(workingFor)}
              onSelect={() => { setWorkingFor(option); }}
              last={index === options.length - 1}
            />
          ))}
        </FormSection>

        <FormSection label="STARTED">
          <DayStepper testID="edit-shift-start-date" day={day} today={new Date()} onStep={by => { setOffset(offset + by); }} />
          <TimeOfDayFields testID="edit-shift-start-time" time={time} />
        </FormSection>
        {tooLate && first !== null ? (
          <Text style={styles.error} testID="edit-shift-error">
            {`The start can't be after ${first.name} began, ${formatDateTime(first.at)}.`}
          </Text>
        ) : null}

        <Text style={styles.hint}>Choosing who it is for sends nothing. Your final choice on the Review decides that.</Text>
        <View style={formStyles.action}>
          <PrimaryButton label="Save" onPress={save} disabled={!canSave} submitting={submitting} testID="edit-shift-save" />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  error: { ...typography.error, marginTop: -spacing.md, marginBottom: spacing.lg, marginLeft: spacing.xs },
  hint: { ...typography.helper, marginBottom: spacing.lg, marginHorizontal: spacing.xs },
});
